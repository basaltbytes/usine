import type { ManagedRepo } from "@usine/config/factory";
import type { LoopFile } from "@usine/config/loop";
import { ConfigParser } from "@usine/config/parser";
import { environmentFor, repositoryContext } from "@usine/config/payload-slices";
import { AttemptTask } from "@usine/core/attempt";
import { DedupKey } from "@usine/core/event";
import { CommitSha, RepositoryRevision, canonicalRepositoryName } from "@usine/core/repository";
import { RunEngine, type SubmissionResult } from "@usine/engine/engine";
import type { ObservedItem } from "./repository-sync.ts";
import { ExpressionEngine } from "@usine/expression/expression-engine";
import { InvalidGitHubResponseError } from "@usine/github/github-app";
import { DateTime, Effect, Result, Schema } from "effect";
import {
  configFileErrorLogFields,
  DEFAULT_BRANCH_REVISION,
  type ResolvedLoop,
  submissionLogFields,
  triggerSubmission,
} from "../trigger-submission.ts";
import { RepositoryPollFailure } from "./cycle.ts";

interface ItemCycle {
  readonly submissions: ReadonlyArray<SubmissionResult>;
  readonly revokedRuns: number;
  /** Failures scoped to one loop; the cursor still advances past them. */
  readonly failures: ReadonlyArray<RepositoryPollFailure>;
}

const eventKey = (
  loop: LoopFile,
  repository: ManagedRepo,
  { projection: item, cycleGeneration }: ObservedItem,
): DedupKey =>
  DedupKey.make(
    JSON.stringify([
      loop.name,
      canonicalRepositoryName(repository.name),
      item.number,
      item.contentHash,
      // Preserve pre-budget identities while making every reset a fresh Event
      // with the current rendered task, Agent and authored limit.
      ...(cycleGeneration === 0 ? [] : [cycleGeneration]),
    ]),
  );

/**
 * Evaluates an already projected Item against its repository's active Loops,
 * renders matching prompts, and submits or revokes Runs. Prompt-render failures
 * are reported per Loop; expression and Run failures stop the repository before
 * its cursor commits. Schedule Ticks have separate evaluation semantics.
 */
export const evaluateItem = Effect.fn("PollingTriggers.evaluateItem")(function* (
  repository: ManagedRepo,
  resolved: ReadonlyArray<ResolvedLoop>,
  observed: ObservedItem,
) {
  const { projection: item, cycleGeneration } = observed;
  yield* Effect.annotateCurrentSpan({
    repository: repository.name,
    item: item.number,
  });
  const config = yield* ConfigParser;
  const expressions = yield* ExpressionEngine;
  const runs = yield* RunEngine;
  const loops = resolved.filter(({ loop }) => loop.trigger.on === item.source);
  const payload = item.payload;
  const context = { repo: repositoryContext(repository), item: payload };
  if (loops.length === 0) {
    yield* Effect.logDebug("Item projected without any matching repository Loop", {
      repository: repository.name,
      item: item.number,
      stream: item.source,
    });
    return { submissions: [], revokedRuns: 0, failures: [] } satisfies ItemCycle;
  }
  const submissions: Array<SubmissionResult> = [];
  // Projections store generic JSON; decode the GitHub PR revision at this boundary.
  const revision =
    item.source === "pr"
      ? RepositoryRevision.make(
          yield* Schema.decodeUnknownEffect(CommitSha)(payload.headRefOid).pipe(
            Effect.mapError(
              () =>
                new InvalidGitHubResponseError({
                  operation: "fetch-pull-request-snapshot",
                  message: "The pull request payload has no valid head commit",
                  detail: `PR ${item.number} requires a full headRefOid`,
                }),
            ),
          ),
        )
      : DEFAULT_BRANCH_REVISION;
  const failures: Array<RepositoryPollFailure> = [];
  let revokedRuns = 0;
  for (const { agent, loop, parentModel } of loops) {
    yield* Effect.annotateCurrentSpan({ loop: loop.name, agent: agent.name });
    const matches = yield* expressions.evaluateBoolean(
      loop.trigger.if,
      environmentFor(loop.trigger.on),
      context,
    );
    if (!matches) {
      yield* Effect.logDebug("Item did not match its loop expression", {
        repository: repository.name,
        loop: loop.name,
        agent: agent.name,
        item: item.number,
      });
      const revoked = yield* runs.revoke(loop.name, item.itemKey);
      revokedRuns += revoked.length;
      if (revoked.length > 0) {
        yield* Effect.logInfo("Item stopped matching; revoked its unstarted runs", {
          repository: repository.name,
          loop: loop.name,
          agent: agent.name,
          item: item.number,
          runIds: revoked.join(", "),
        });
      }
      continue;
    }

    const dedupKey = eventKey(loop, repository, observed);
    const receivedAt = yield* DateTime.now;
    // A render failure comes from the loop's authoring, not transport, so
    // re-polling would fail the same way. It is scoped to this loop so the
    // sibling loops and the cursor still advance.
    const rendered = yield* Effect.result(config.renderPrompt(loop, context));
    if (Result.isFailure(rendered)) {
      yield* Effect.logError("Loop prompt rendering failed; sibling loops were unaffected", {
        loop: loop.name,
        repository: repository.name,
        agent: agent.name,
        item: item.number,
        errorTag: rendered.failure._tag,
        message: rendered.failure.message,
        ...configFileErrorLogFields(rendered.failure),
      });
      failures.push(
        new RepositoryPollFailure({
          repository: repository.name,
          errorTag: rendered.failure._tag,
          message: rendered.failure.message,
        }),
      );
      continue;
    }
    const submitted = yield* runs.submit(
      triggerSubmission({
        dedupKey,
        cycleGeneration,
        itemKey: item.itemKey,
        loop,
        payload,
        receivedAt,
        repository,
        revision,
        task: AttemptTask.make(rendered.success),
        agent,
        parentModel,
      }),
    );
    yield* Effect.logInfo("Submitted matching item state", {
      repository: repository.name,
      loop: loop.name,
      agent: agent.name,
      item: item.number,
      contentHash: item.contentHash,
      revision,
      result: submitted._tag,
      ...submissionLogFields(submitted),
    });
    submissions.push(submitted);
  }
  return { submissions, revokedRuns, failures } satisfies ItemCycle;
});
