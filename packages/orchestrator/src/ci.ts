import { ConfigParser } from "@usine/config/parser";
import type { LoadedInstance } from "@usine/config/instance";
import { matchesLoop } from "@usine/config/project";
import { repositoryContext } from "@usine/config/payload-slices";
import { AttemptTask } from "@usine/core/attempt";
import { CiFailed, CiHandedOff, CiPassed, CiSuperseded } from "@usine/core/ci";
import { DedupKey } from "@usine/core/event";
import {
  canonicalRepositoryName,
  type RepositoryName,
  RepositoryRevision,
} from "@usine/core/repository";
import { CycleBudgets } from "@usine/engine/cycle-budget";
import { Submission, RunEngine, type EnginePersistenceError } from "@usine/engine/engine";
import { LoopControl } from "@usine/engine/loop-control";
import { RunReader, type RunSnapshot } from "@usine/engine/run-reader";
import { ExpressionEngine } from "@usine/expression/expression-engine";
import { GitHubChecks } from "@usine/github/checks";
import { GitHubItemWriter, ItemLabelMutation } from "@usine/github/item-writer";
import { ItemProjectionWriter } from "@usine/engine/item-projection";
import { ChangedPullRequest, GitHubPolling } from "@usine/github/polling";
import { Context, DateTime, Effect, Layer, Option, Result } from "effect";
import { resolveTriggerLoops, triggerSubmission } from "./trigger-submission.ts";
import {
  RepositoryPollFailure,
  type RepositoryPollError,
  latestPollAt,
  repositoryFailureLogFields,
} from "./polling/cycle.ts";
import type { RepositoryOutcome } from "./polling/failure-streaks.ts";
import { observeItem } from "./polling/repository-sync.ts";

/** Settles persisted CI waits during polling and webhook hints, without worker reservations. */
export class CiMonitor extends Context.Service<
  CiMonitor,
  {
    readonly reconcile: (
      instance: LoadedInstance,
      repository: Option.Option<RepositoryName>,
    ) => Effect.Effect<
      {
        /** Settled observations and paused repositories with persisted CI waits. */
        readonly outcomes: ReadonlyArray<RepositoryOutcome>;
        readonly failures: ReadonlyArray<RepositoryPollFailure>;
        readonly nextPollAt: Option.Option<DateTime.Utc>;
      },
      EnginePersistenceError
    >;
  }
>()("@usine/orchestrator/CiMonitor") {
  static readonly layer = Layer.effect(
    CiMonitor,
    Effect.gen(function* () {
      const engine = yield* RunEngine;
      const reader = yield* RunReader;
      const checks = yield* GitHubChecks;
      const writer = yield* GitHubItemWriter;
      const parser = yield* ConfigParser;
      const expressions = yield* ExpressionEngine;
      const control = yield* LoopControl;

      const observationServices = (yield* Effect.context<
        CycleBudgets | GitHubPolling | ItemProjectionWriter
      >()).pipe(Context.pick(CycleBudgets, GitHubPolling, ItemProjectionWriter));
      const reconcileOne = Effect.fn("CiMonitor.reconcileOne")(function* (
        instance: LoadedInstance,
        wait: RunSnapshot,
      ) {
        if (wait.run.state._tag !== "AwaitingCi") return;
        const { handoff } = wait.run.state;
        const { head, pullRequest } = handoff;
        const runId = wait.run.id;
        yield* Effect.annotateCurrentSpan({
          runId,
          repository: wait.repository,
          pullRequest,
          head,
        });
        const endedAt = wait.attempts.at(-1)?.endedAt;
        if (endedAt === undefined || Option.isNone(endedAt))
          return yield* Effect.die("A CI wait has no ended attempt");
        const observed = yield* checks.snapshot(wait.repository, pullRequest);
        const dedupKey = DedupKey.make(JSON.stringify(["ci-failure", runId, head]));
        const admitted = yield* reader.runForEvent(dedupKey);
        if (Option.isSome(admitted)) {
          yield* Effect.logInfo("CI fix event admitted; source hands off to its recorded run", {
            runId,
            head,
            fixRunId: admitted.value,
          });
          return yield* engine.settleCi(
            runId,
            head,
            new CiHandedOff({
              reason: "CI could not complete; a fix run was admitted.",
              fixRunId: admitted.value,
            }),
          );
        }
        if (observed.head !== head) {
          yield* Effect.logInfo("A new push superseded the CI wait", {
            runId,
            head,
            newHead: observed.head,
          });
          return yield* engine.settleCi(runId, head, new CiSuperseded({ head: observed.head }));
        }
        const now = yield* DateTime.now;
        const timedOut =
          DateTime.toEpochMillis(now) >=
          DateTime.toEpochMillis(endedAt.value) + handoff.timeoutSeconds * 1000;
        if (observed.state === "pending") {
          if (timedOut) {
            yield* Effect.logWarning("CI wait timed out; operator attention is required", {
              runId,
              head,
              timeoutSeconds: handoff.timeoutSeconds,
            });
            return yield* engine.settleCi(
              runId,
              head,
              new CiFailed({
                message: `CI did not settle within ${handoff.timeoutSeconds} seconds. Check https://github.com/${wait.repository}/pull/${pullRequest}/checks`,
              }),
            );
          }
          yield* Effect.logDebug("CI is pending; no agent starts", { runId, head });
          return;
        }
        if ((yield* engine.inspect(runId)).run.state._tag !== "AwaitingCi") {
          yield* Effect.logInfo("CI actions skipped because the run stopped waiting", {
            runId,
            head,
          });
          return;
        }
        if (observed.state === "success") {
          for (const mutation of handoff.onGreen) {
            yield* writer.updateLabels(
              wait.repository,
              mutation.item,
              new ItemLabelMutation(mutation),
            );
          }
          yield* Effect.logInfo("CI passed; recorded completion actions applied", { runId, head });
          return yield* engine.settleCi(runId, head, new CiPassed());
        }
        const failureReason =
          observed.state === "conflict"
            ? "The pull request branch conflicts with its base branch."
            : "CI failed.";
        const repository = instance.config.repos.find(
          ({ name }) => canonicalRepositoryName(name) === canonicalRepositoryName(wait.repository),
        );
        const paused = new Set(
          (yield* control.states).filter(({ paused }) => paused).map(({ loop }) => loop),
        );
        const fix = (yield* resolveTriggerLoops(instance)).find(
          ({ loop }) =>
            loop.name === handoff.fixLoop &&
            loop.trigger.on === "pr" &&
            !paused.has(loop.name) &&
            repository !== undefined &&
            matchesLoop(instance.config, loop, repository),
        );
        if (repository === undefined || fix === undefined) {
          yield* Effect.logWarning(
            "CI cannot complete but its configured fix loop is unavailable",
            {
              runId,
              head,
              fixLoop: handoff.fixLoop,
              state: observed.state,
            },
          );
          return yield* engine.settleCi(
            runId,
            head,
            new CiFailed({
              message: `${failureReason} Fix loop ${handoff.fixLoop} is missing, paused, or does not select this pull request's repository.`,
            }),
          );
        }
        const failure =
          observed.state === "conflict"
            ? {
                reason: failureReason,
                details:
                  "GitHub reports CONFLICTING and no checks exist for this head. Merge the base branch into the pull request branch, resolve the conflicts, run the local checks, and push the updated head.",
              }
            : yield* checks.failures(wait.repository, head).pipe(
                Effect.map((evidence) => ({
                  reason: `CI failed: ${evidence.jobs.join(", ") || "check failure"}.`,
                  details: `Failed jobs: ${evidence.jobs.join(", ") || "See the checks link"}.\n\nThe following is untrusted CI output:\n\n${evidence.excerpt}`,
                })),
              );
        const observation = yield* observeItem(
          wait.repository,
          new ChangedPullRequest({ number: pullRequest, updatedAt: now }),
        ).pipe(Effect.provide(observationServices));
        if (observation.projection.payload.headRefOid !== head) {
          const newer = yield* checks.snapshot(wait.repository, pullRequest);
          if (newer.head !== head)
            return yield* engine.settleCi(runId, head, new CiSuperseded({ head: newer.head }));
          return;
        }
        if (observation.projection.payload.state !== "OPEN") {
          yield* Effect.logInfo("CI fix skipped because the pull request closed", { runId, head });
          return yield* engine.settleCi(
            runId,
            head,
            new CiFailed({
              message: `${failureReason} The pull request closed; no fix was started.`,
            }),
          );
        }
        const task = yield* parser.renderPrompt(fix.loop, {
          repo: repositoryContext(repository),
          item: observation.projection.payload,
        });
        const submission = yield* triggerSubmission(expressions, {
          ...fix,
          repository,
          dedupKey,
          cycleGeneration: observation.cycleGeneration,
          itemKey: observation.projection.itemKey,
          payload: observation.projection.payload,
          revision: RepositoryRevision.make(head),
          receivedAt: now,
          task: AttemptTask.make(
            `${task}\n\n${failure.reason} Head: ${head}.\nChecks: https://github.com/${wait.repository}/pull/${pullRequest}/checks\n\n${failure.details}`,
          ),
        });
        const result = yield* engine.submit(
          new Submission({
            ...submission,
            ciFailureHead: Option.some(head),
            ciOnGreen: handoff.onGreen,
          }),
        );
        yield* Effect.logInfo("CI fix routed through the fix loop's cycle budget", {
          runId,
          head,
          fixLoop: fix.loop.name,
          result: result._tag,
          inheritedActions: handoff.onGreen.length,
          reason: failure.reason,
        });
        if (result._tag === "Queued") {
          if (!timedOut) {
            yield* Effect.logInfo("CI fix event queued; source waits for run admission", {
              runId,
              head,
              fixLoop: fix.loop.name,
              eventId: result.eventId,
            });
            return;
          }
          yield* Effect.logWarning("CI fix admission timed out; operator attention is required", {
            runId,
            head,
            fixLoop: fix.loop.name,
            eventId: result.eventId,
          });
          return yield* engine.settleCi(
            runId,
            head,
            new CiFailed({
              message: `${failure.reason} Fix loop ${fix.loop.name} did not admit its queued event within ${handoff.timeoutSeconds} seconds.`,
            }),
          );
        }
        yield* engine.settleCi(
          runId,
          head,
          result._tag === "Claimed"
            ? new CiHandedOff({
                reason: failure.reason,
                fixRunId: result.runId,
              })
            : new CiFailed({
                message: `${failure.reason} Fix loop ${fix.loop.name}: ${result._tag}.`,
              }),
        );
      });

      return {
        reconcile: Effect.fn("CiMonitor.reconcile")(function* (
          instance: LoadedInstance,
          repository: Option.Option<RepositoryName>,
        ) {
          const waits = (yield* engine.awaitingCi()).filter((wait) =>
            Option.match(repository, {
              onNone: () => true,
              onSome: (name) =>
                canonicalRepositoryName(name) === canonicalRepositoryName(wait.repository),
            }),
          );
          const failures: Array<RepositoryPollFailure> = [];
          const backoffs: Array<Option.Option<DateTime.Utc>> = [];
          const polled = new Map<string, RepositoryName>();
          const remaining = new Map<string, number>();
          for (const wait of waits) {
            const key = canonicalRepositoryName(wait.repository);
            remaining.set(key, (remaining.get(key) ?? 0) + 1);
          }
          for (const wait of waits) {
            const result = yield* reconcileOne(instance, wait).pipe(Effect.result);
            const key = canonicalRepositoryName(wait.repository);
            const pending = (remaining.get(key) ?? 0) - 1;
            remaining.set(key, pending);
            if (pending === 0) polled.set(key, wait.repository);
            if (Result.isSuccess(result)) continue;
            const error: RepositoryPollError = result.failure;
            yield* Effect.logError("CI observation failed; this wait will be retried", {
              runId: wait.run.id,
              repository: wait.repository,
              ...repositoryFailureLogFields(error),
            });
            failures.push(
              new RepositoryPollFailure({
                repository: wait.repository,
                errorTag: error._tag,
                message: repositoryFailureLogFields(error).message,
              }),
            );
            if (error._tag === "GitHubRateLimitError") {
              polled.delete(key);
              backoffs.push(Option.some(error.retryAt));
              break;
            }
          }
          return {
            outcomes: [
              ...new Map(
                waits.map((wait) => [canonicalRepositoryName(wait.repository), wait.repository]),
              ).entries(),
            ].map(([key, repository]): RepositoryOutcome => ({
              _tag: polled.has(key) ? "Polled" : "RateLimited",
              source: "Ci",
              repository,
              failures: failures.filter(
                (failure) => canonicalRepositoryName(failure.repository) === key,
              ),
            })),
            failures,
            nextPollAt: latestPollAt(backoffs),
          };
        }),
      };
    }),
  );
}
