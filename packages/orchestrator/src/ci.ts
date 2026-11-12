import { ConfigParser } from "@usine/config/parser";
import type { LoadedInstance } from "@usine/config/instance";
import { matchesLoop } from "@usine/config/project";
import { repositoryContext } from "@usine/config/payload-slices";
import { AttemptTask } from "@usine/core/attempt";
import {
  CiFailed,
  type CiHandoff,
  CiHandedOff,
  CiIncomplete,
  CiPassed,
  CiPullRequestClosed,
  CiSuperseded,
  CiTimedOut,
} from "@usine/core/ci";
import type { AttemptId } from "@usine/core/attempt";
import type { OperatorActor } from "@usine/core/operator";
import { RunId } from "@usine/core/run";
import {
  canonicalRepositoryName,
  CommitSha,
  type RepositoryName,
  RepositoryRevision,
} from "@usine/core/repository";
import { CycleBudgets } from "@usine/engine/cycle-budget";
import {
  ciFixDedupKey,
  type EnginePersistenceError,
  RunEngine,
  RunOperationRejectedError,
  type RunEngineError,
  Submission,
} from "@usine/engine/engine";
import { LoopControl } from "@usine/engine/loop-control";
import { RunReader, type RunSnapshot } from "@usine/engine/run-reader";
import { ExpressionEngine } from "@usine/expression/expression-engine";
import {
  type CheckFailureEvidence,
  type FailedCheck,
  GitHubChecks,
  HeadWorkflowRunState,
  type IncompleteWorkflowRun,
  type PendingCheck,
  type PendingCheckReport,
  type RunningWorkflowRun,
} from "@usine/github/checks";
import { GitHubItemWriter, ItemLabelMutation } from "@usine/github/item-writer";
import { ItemProjectionWriter } from "@usine/engine/item-projection";
import { ChangedPullRequest, GitHubPolling } from "@usine/github/polling";
import type { GitHubAppError } from "@usine/github/github-app";
import { type Brand, Context, DateTime, Effect, Layer, Option, Result, Schema } from "effect";
import { resolveTriggerLoops, triggerSubmission } from "./trigger-submission.ts";
import {
  RepositoryPollFailure,
  type RepositoryPollError,
  latestPollAt,
  repositoryFailureLogFields,
} from "./polling/cycle.ts";
import type { RepositoryOutcome } from "./polling/failure-streaks.ts";
import { observeItem } from "./polling/repository-sync.ts";

const durationMinutes = (milliseconds: number) => `${Math.ceil(milliseconds / 60000)} min`;

const pendingCheckDetail = (check: PendingCheck) => {
  if (check.status !== "in_progress")
    return `${check.name} is ${check.status.replaceAll("_", " ")}.`;
  const running = Option.match(check.elapsedMilliseconds, {
    onNone: () => `${check.name} is running with no recorded start time`,
    onSome: (milliseconds) => `${check.name} has been running for ${durationMinutes(milliseconds)}`,
  });
  const previous = Option.match(check.previousDurationMilliseconds, {
    onNone: () => "no previous successful duration is available",
    onSome: (milliseconds) => `its last successful run took ${durationMinutes(milliseconds)}`,
  });
  return `${running}; ${previous}.`;
};

const pendingCheckDetails = ({ checks, omitted }: PendingCheckReport) =>
  checks.length === 0
    ? "No pending check runs or commit statuses were reported for this head."
    : [
        ...checks.map(pendingCheckDetail),
        ...(omitted === 0
          ? []
          : [`${omitted} more pending ${omitted === 1 ? "check is" : "checks are"} not listed.`]),
      ].join(" ");

const workflowRunDetails = (runs: ReadonlyArray<IncompleteWorkflowRun | RunningWorkflowRun>) =>
  runs
    .map((run) => {
      const state = "conclusion" in run ? run.conclusion : run.status;
      const lone = Option.match(run.loneFailure, {
        onNone: () => "",
        onSome: ({ job, unfinished }) =>
          `; job ${job} failed while ${unfinished.join(", ")} didn't finish`,
      });
      return `${run.workflow} (run ${run.id}, ${state}${lone}): ${run.url}`;
    })
    .join("; ");

/**
 * Returns whether a failed check only reflects a workflow run on the head that didn't run or
 * finish in full: it is the run's lone failed job, or a job of an earlier attempt of a run that
 * GitHub Actions reran. Checks without an Actions job never match.
 */
const unfinishedRunFailure = ({ incomplete, running }: HeadWorkflowRunState) => {
  const runs = new Map([...incomplete, ...running].map((run) => [run.id, run]));
  return ({ actionsJob }: FailedCheck) =>
    Option.exists(actionsJob, ({ runId, jobId }) => {
      const run = runs.get(runId);
      return (
        run !== undefined &&
        (!run.jobIds.includes(jobId) ||
          Option.exists(run.loneFailure, (lone) => lone.jobId === jobId))
      );
    });
};

/**
 * Returns how workflow runs that didn't run or finish in full end a CI wait without another failed
 * job. `Incomplete` is CI that ran only in part, including a lone failed job whose sibling jobs are
 * still queued at the deadline. `Stalled` is a run still going at the deadline, and `Running` one
 * that keeps the wait pending.
 */
const unfinishedCi = ({ incomplete, running }: HeadWorkflowRunState, timedOut: boolean) => {
  const held = running.filter(({ loneFailure }) => Option.isSome(loneFailure));
  if (incomplete.length > 0 || (timedOut && held.length > 0))
    return { _tag: "Incomplete", runs: [...incomplete, ...held] } as const;
  if (running.length === 0) return { _tag: "Concluded" } as const;
  return { _tag: timedOut ? "Stalled" : "Running", runs: running } as const;
};

const checksUrl = (repository: RepositoryName, pullRequest: number) =>
  `https://github.com/${repository}/pull/${pullRequest}/checks`;

const afterGreen = (head: CommitSha) =>
  `After CI on head ${head} passes, apply the completion labels from Needs attention.`;

/**
 * CI on the recorded head of a failed CI wait hasn't passed, or its pull request closed without a
 * merge, so its completion labels stay unapplied.
 */
export class CiNotPassedError extends Schema.TaggedError<
  CiNotPassedError,
  Brand.Brand<"@usine/orchestrator/ci/CiNotPassedError">
>("@usine/orchestrator/CiNotPassedError")("CiNotPassedError", {
  runId: RunId,
  head: CommitSha,
  /** An operator-facing explanation of what CI on the head still lacks. */
  message: Schema.NonEmptyString,
}) {}

const PENDING_DIAGNOSTICS_LIMIT = "10 seconds";
const PENDING_HISTORY_LIMIT = { seconds: 7 };

const noWorkflowRuns = HeadWorkflowRunState.make({ incomplete: [], running: [] });

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
    /**
     * Applies the completion labels of a Run whose CI wait ended because CI on its head didn't
     * finish, then resolves the failure of `attemptId`. CI on the recorded head must read green
     * with every workflow run on it concluded in full, and the pull request must not be closed
     * without a merge. Fails with `CiNotPassedError` otherwise, or with `RunOperationRejectedError`
     * if the Run kept no CI handoff or `attemptId` isn't its unresolved latest failure.
     */
    readonly applyLabelsAfterGreen: (
      runId: RunId,
      attemptId: AttemptId,
      operator: Option.Option<OperatorActor>,
    ) => Effect.Effect<void, CiNotPassedError | RunEngineError | GitHubAppError>;
  }
>()("@usine/orchestrator/ci/CiMonitor") {
  static readonly layer = Layer.effect(
    CiMonitor,
    Effect.gen(function* () {
      const engine = yield* RunEngine;
      const budgets = yield* CycleBudgets;
      const reader = yield* RunReader;
      const checks = yield* GitHubChecks;
      const writer = yield* GitHubItemWriter;
      const parser = yield* ConfigParser;
      const expressions = yield* ExpressionEngine;
      const control = yield* LoopControl;

      const observationServices = (yield* Effect.context<
        CycleBudgets | GitHubPolling | ItemProjectionWriter
      >()).pipe(Context.pick(CycleBudgets, GitHubPolling, ItemProjectionWriter));
      // A person decided the outcome of a closed or merged pull request, so the Run ends without
      // an agent failure: a merge passes, and a close without a merge cancels the Run.
      const settleClosed = Effect.fn("CiMonitor.settleClosed")(function* (
        runId: RunId,
        handoff: CiHandoff,
        merged: boolean,
        when: string,
      ) {
        const { head, pullRequest } = handoff;
        if (merged) {
          yield* Effect.logInfo(
            "The pull request was merged before CI passed; the CI wait passes without completion labels",
            {
              runId,
              head,
              pullRequest,
              detail: `Pull request #${pullRequest} was merged ${when} on head ${head}. usine applied no completion labels and started no fix.`,
            },
          );
          return yield* engine.settleCi(runId, head, CiPassed.make());
        }
        yield* Effect.logInfo(
          "The pull request was closed without a merge before CI passed; the run is canceled",
          {
            runId,
            head,
            pullRequest,
            detail: `Pull request #${pullRequest} was closed ${when} on head ${head}. usine applied no completion labels and started no fix.`,
          },
        );
        return yield* engine.settleCi(runId, head, CiPullRequestClosed.make({ pullRequest }));
      });
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
        const dedupKey = ciFixDedupKey(runId, head);
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
            CiHandedOff.make({
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
          return yield* engine.settleCi(runId, head, CiSuperseded.make({ head: observed.head }));
        }
        // GitHub stops updating a closed pull request's head, so its CI wait would last until the
        // deadline, and a fix can't land on it. Green CI on a merged head still passes with labels.
        if (
          observed.pullRequestState === "closed" ||
          (observed.pullRequestState === "merged" && observed.state !== "success")
        ) {
          return yield* settleClosed(
            runId,
            handoff,
            observed.pullRequestState === "merged",
            observed.state === "pending"
              ? "before CI settled"
              : observed.state === "conflict"
                ? "while it conflicted with its base branch"
                : observed.state === "failure"
                  ? "after CI failed"
                  : "after CI passed",
          );
        }
        const now = yield* DateTime.now;
        const timedOut =
          DateTime.toEpochMillis(now) >=
          DateTime.toEpochMillis(endedAt.value) + handoff.timeoutSeconds * 1000;
        // History reads stop early, so the job list survives a slow history read.
        const pendingDiagnostics = checks
          .pendingDetails(wait.repository, head, DateTime.add(now, PENDING_HISTORY_LIMIT))
          .pipe(
            Effect.timeout(PENDING_DIAGNOSTICS_LIMIT),
            Effect.map(pendingCheckDetails),
            Effect.catch((error) =>
              Effect.logWarning("Pending CI diagnostics unavailable", {
                runId,
                head,
                ...(error._tag === "TimeoutError"
                  ? { errorTag: error._tag, message: error.message }
                  : repositoryFailureLogFields(error)),
              }).pipe(Effect.as("Pending job diagnostics are unavailable.")),
            ),
          );
        // Settles CI that GitHub Actions didn't run or finish in full, or keeps the wait pending
        // while a run goes on. Returns `false` once every workflow run concluded in full.
        const settleUnfinished = Effect.fn("CiMonitor.settleUnfinished")(function* (
          runs: HeadWorkflowRunState,
        ) {
          const unfinished = unfinishedCi(runs, timedOut);
          const ids = unfinished._tag === "Concluded" ? [] : unfinished.runs.map(({ id }) => id);
          const fields = { runId, head, state: observed.state, runs: ids };
          yield* Effect.annotateCurrentSpan({ outcome: unfinished._tag, runs: ids });
          switch (unfinished._tag) {
            case "Concluded":
              return false;
            case "Running":
              yield* Effect.logInfo(
                "Workflow runs on the head have not concluded; CI is still pending",
                fields,
              );
              return true;
            case "Incomplete":
              yield* Effect.logWarning(
                "CI ran only in part; operator attention is required and no fix starts",
                fields,
              );
              yield* engine.settleCi(
                runId,
                head,
                CiIncomplete.make({
                  message: `GitHub Actions didn't run CI on head ${head} in full, so it isn't a failure that a fix can address: ${workflowRunDetails(unfinished.runs)}. usine applied no completion labels and started no fix. Rerun these workflow runs once GitHub allows it, or push a commit to start new ones. ${afterGreen(head)} Check ${checksUrl(wait.repository, pullRequest)}`,
                }),
              );
              return true;
            case "Stalled": {
              // The pending jobs tell a stalled run apart from a slow or hung job.
              const details = yield* pendingDiagnostics;
              yield* Effect.logWarning(
                "CI wait timed out while workflow runs had not concluded; operator attention is required",
                { ...fields, details },
              );
              yield* engine.settleCi(
                runId,
                head,
                CiTimedOut.make({
                  message: `CI did not settle within ${handoff.timeoutSeconds} seconds because GitHub Actions didn't finish these workflow runs on head ${head}: ${workflowRunDetails(unfinished.runs)}. ${details} usine applied no completion labels and started no fix. Push a commit to start new runs, or rerun these workflow runs once GitHub allows it. ${afterGreen(head)} Check ${checksUrl(wait.repository, pullRequest)}`,
                }),
              );
              return true;
            }
          }
        });
        const readWorkflowRuns = checks.workflowRuns(wait.repository, head).pipe(
          Effect.catchIf(
            (error) => error._tag !== "GitHubRateLimitError",
            (error) =>
              Effect.logWarning(
                "Workflow runs on the head are unreadable; the check rollup decides alone",
                { runId, head, errorTag: error._tag },
              ).pipe(Effect.as(noWorkflowRuns)),
          ),
        );
        if (observed.state === "pending") {
          if (timedOut) {
            // A stalled Actions run can stay queued with no jobs, so no pending check names it.
            const runs = yield* readWorkflowRuns.pipe(
              Effect.timeoutOrElse({
                duration: PENDING_DIAGNOSTICS_LIMIT,
                orElse: () =>
                  Effect.logWarning("Workflow runs on the head weren't read in time", {
                    runId,
                    head,
                  }).pipe(Effect.as(noWorkflowRuns)),
              }),
            );
            if (yield* settleUnfinished(runs)) return;
            const details = yield* pendingDiagnostics;
            yield* Effect.logWarning("CI wait timed out; operator attention is required", {
              runId,
              head,
              timeoutSeconds: handoff.timeoutSeconds,
              details,
            });
            return yield* engine.settleCi(
              runId,
              head,
              CiTimedOut.make({
                message: `CI did not settle within ${handoff.timeoutSeconds} seconds. ${details} Check ${checksUrl(wait.repository, pullRequest)}`,
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
        const reported =
          observed.state === "failure"
            ? yield* checks.failures(wait.repository, head).pipe(Effect.asSome)
            : Option.none<CheckFailureEvidence>();
        const runs = observed.state === "conflict" ? noWorkflowRuns : yield* readWorkflowRuns;
        // A gate job that failed because the jobs it needs never ran is no failure to fix.
        const isUnfinishedRunFailure = unfinishedRunFailure(runs);
        const unfinishedFailures = Option.match(reported, {
          onNone: () => [],
          onSome: ({ checks }) => checks.filter(isUnfinishedRunFailure),
        });
        // `failures` reads commit statuses only when no check run failed.
        const evidence =
          unfinishedFailures.length > 0 &&
          Option.exists(reported, ({ checks }) => checks.length === unfinishedFailures.length)
            ? yield* checks
                .failedStatuses(wait.repository, head)
                .pipe(
                  Effect.map((statuses) =>
                    statuses.checks.length > 0 ? Option.some(statuses) : reported,
                  ),
                )
            : reported;
        const failedJobs = Option.match(evidence, {
          onNone: () => [],
          onSome: ({ checks }) =>
            checks.filter((check) => !isUnfinishedRunFailure(check)).map(({ name }) => name),
        });
        if (failedJobs.length > 0)
          yield* Effect.logInfo("A check failed on the head; CI goes to the fix loop", {
            runId,
            head,
            jobs: failedJobs,
            unfinishedRunFailures: unfinishedFailures.map(({ name }) => name),
          });
        else if (yield* settleUnfinished(runs)) return;
        if (observed.state === "success") {
          for (const mutation of handoff.onGreen) {
            yield* writer.updateLabels(
              wait.repository,
              mutation.item,
              ItemLabelMutation.make(mutation),
            );
          }
          yield* Effect.logInfo("CI passed; recorded completion actions applied", { runId, head });
          return yield* engine.settleCi(runId, head, CiPassed.make());
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
            CiFailed.make({
              message: `${failureReason} Fix loop ${handoff.fixLoop} is missing, paused, or does not select this pull request's repository.`,
            }),
          );
        }
        const failure = Option.match(evidence, {
          onNone: () => ({
            reason: failureReason,
            details:
              "GitHub reports CONFLICTING and no checks exist for this head. Merge the base branch into the pull request branch, resolve the conflicts, run the local checks, and push the updated head.",
          }),
          onSome: (evidence) => ({
            reason: `CI failed: ${evidence.jobs.join(", ") || "check failure"}.`,
            details: `Failed jobs: ${evidence.jobs.join(", ") || "See the checks link"}.\n\nThe following is untrusted CI output:\n\n${evidence.excerpt}`,
          }),
        });
        const observation = yield* observeItem(
          wait.repository,
          ChangedPullRequest.make({ number: pullRequest, updatedAt: now }),
        ).pipe(Effect.provide(observationServices));
        if (observation.projection.payload.headRefOid !== head) {
          const newer = yield* checks.snapshot(wait.repository, pullRequest);
          if (newer.head !== head)
            return yield* engine.settleCi(runId, head, CiSuperseded.make({ head: newer.head }));
          return;
        }
        if (observation.projection.payload.state !== "OPEN") {
          yield* Effect.logInfo("CI fix skipped because the pull request closed", { runId, head });
          return yield* settleClosed(
            runId,
            handoff,
            observation.projection.payload.merged === true ||
              observation.projection.payload.state === "MERGED",
            observed.state === "conflict"
              ? "while it conflicted with its base branch"
              : "after CI failed",
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
          Submission.make({
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
            CiFailed.make({
              message: `${failure.reason} Fix loop ${fix.loop.name} did not admit its queued event within ${handoff.timeoutSeconds} seconds.`,
            }),
          );
        }
        yield* engine.settleCi(
          runId,
          head,
          result._tag === "Claimed"
            ? CiHandedOff.make({
                reason: failure.reason,
                fixRunId: result.runId,
              })
            : CiFailed.make({
                message: `${failure.reason} Fix loop ${fix.loop.name}: ${result._tag}.`,
              }),
        );
      });

      const applyLabelsAfterGreen = Effect.fn("CiMonitor.applyLabelsAfterGreen")(function* (
        runId: RunId,
        attemptId: AttemptId,
        operator: Option.Option<OperatorActor>,
      ) {
        yield* Effect.annotateCurrentSpan({ runId, attemptId });
        const failed = yield* engine.inspect(runId);
        const { state } = failed.run;
        if (
          state._tag !== "Failed" ||
          Option.isNone(state.unfinishedCi) ||
          failed.attempts.at(-1)?.id !== attemptId ||
          Option.contains(failed.resolvedFailureAttemptId, attemptId)
        ) {
          yield* Effect.logInfo("CI labels not applied; the Run or its failure changed", {
            runId,
            attemptId,
            state: state._tag,
            latestAttemptId: failed.attempts.at(-1)?.id,
          });
          return yield* RunOperationRejectedError.make({
            runId,
            operation: "applyCiLabels",
            state: state._tag,
          });
        }
        const handoff = state.unfinishedCi.value;
        const { head, pullRequest } = handoff;
        yield* Effect.annotateCurrentSpan({ repository: failed.repository, pullRequest, head });
        const notPassed = (reason: string) =>
          Effect.gen(function* () {
            const message = `${reason} usine applied no completion labels. Check ${checksUrl(failed.repository, pullRequest)}`;
            yield* Effect.logInfo("CI labels not applied; CI on the recorded head hasn't passed", {
              runId,
              head,
              message,
            });
            return yield* CiNotPassedError.make({ runId, head, message });
          });
        const observed = yield* checks.snapshot(failed.repository, pullRequest);
        if (observed.head !== head)
          return yield* notPassed(
            `Pull request #${pullRequest} moved from head ${head} to ${observed.head}, so CI on the recorded head can't pass anymore.`,
          );
        // The CI wait cancels a Run whose pull request closed without a merge, with no labels.
        if (observed.pullRequestState === "closed")
          return yield* notPassed(
            `Pull request #${pullRequest} was closed without a merge, so its completion labels no longer apply. Mark the failure resolved instead.`,
          );
        if (observed.state !== "success")
          return yield* notPassed(
            observed.state === "conflict"
              ? `Pull request #${pullRequest} conflicts with its base branch, so no checks run on head ${head}.`
              : `CI on head ${head} is ${observed.state === "pending" ? "still pending" : "red"}.`,
          );
        const runs = yield* checks.workflowRuns(failed.repository, head);
        if (runs.incomplete.length > 0 || runs.running.length > 0)
          return yield* notPassed(
            `CI on head ${head} reads green, but these workflow runs on it didn't finish in full: ${workflowRunDetails([...runs.incomplete, ...runs.running])}.`,
          );
        for (const mutation of handoff.onGreen) {
          yield* writer.updateLabels(
            failed.repository,
            mutation.item,
            ItemLabelMutation.make(mutation),
          );
        }
        yield* engine.resolveFailure(runId, attemptId, operator);
        yield* Effect.logInfo(
          "CI on the recorded head passed after its wait ended; completion labels applied and the failure resolved",
          { runId, attemptId, head, pullRequest, mutations: handoff.onGreen.length },
        );
      });

      // A cycle reset returns blocked CI fixes to the queue; admitting them here spares them the
      // wait for the periodic reconcile.
      const admitReplayedCiFixes = Effect.gen(function* () {
        const resets = yield* budgets.pendingResets;
        if (resets.length === 0) return;
        const opened = yield* engine.admitCiFixes;
        yield* Effect.logDebug("Admitted the queued CI fixes while cycle resets are pending", {
          itemKeys: resets.map(({ itemKey }) => itemKey),
          openedRunIds: opened,
        });
      }).pipe(
        Effect.tapError((error) =>
          Effect.logWarning(
            "Could not admit the CI fixes replayed by a cycle reset; the periodic reconcile retries them",
            { errorTag: error._tag },
          ),
        ),
        Effect.ignore,
        Effect.withSpan("CiMonitor.admitReplayedCiFixes"),
      );

      return {
        applyLabelsAfterGreen,
        reconcile: Effect.fn("CiMonitor.reconcile")(function* (
          instance: LoadedInstance,
          repository: Option.Option<RepositoryName>,
        ) {
          yield* admitReplayedCiFixes;
          const waits = (yield* engine.awaitingCi).filter((wait) =>
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
              RepositoryPollFailure.make({
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
