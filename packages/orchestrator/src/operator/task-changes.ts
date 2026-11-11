import { AttemptId, AttemptNumber } from "@usine/core/attempt";
import { ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { CommitSha } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import type { RunSnapshot } from "@usine/engine/run-reader";
import { type Brand, Option, Schema } from "effect";

/** The latest polled PR head, CI aggregate, and review decision. */
export class TaskPullRequestState extends Schema.Class<
  TaskPullRequestState,
  Brand.Brand<"@usine/orchestrator/operator/TaskPullRequestState">
>("TaskPullRequestState")({
  base: CommitSha,
  head: CommitSha,
  checks: Schema.NullOr(Schema.String),
  review: Schema.NullOr(Schema.String),
}) {}

/**
 * An attempt's recorded commits associated with one pull request. `base` equals `head` when the
 * attempt pushed no new commits.
 */
export class TaskAttemptChangesView extends Schema.Class<
  TaskAttemptChangesView,
  Brand.Brand<"@usine/orchestrator/operator/TaskAttemptChangesView">
>("TaskAttemptChangesView")({
  runId: RunId,
  attemptId: AttemptId,
  number: AttemptNumber,
  loop: LoopName,
  pullRequest: ItemNumber,
  base: CommitSha,
  head: CommitSha,
}) {}

export const harvestedAttemptChanges = (
  snapshot: RunSnapshot,
): ReadonlyArray<TaskAttemptChangesView> =>
  snapshot.attempts.flatMap((attempt) =>
    Option.match(attempt.result, {
      onNone: () => [],
      onSome: (result) =>
        result.facts.flatMap((fact) => {
          if (fact._tag !== "PullRequest" || Option.isNone(fact.base) || Option.isNone(fact.head))
            return [];
          return [
            TaskAttemptChangesView.make({
              runId: snapshot.run.id,
              attemptId: attempt.id,
              number: attempt.number,
              loop: snapshot.run.loop,
              pullRequest: ItemNumber.make(fact.number),
              base: fact.base.value,
              head: fact.head.value,
            }),
          ];
        }),
    }),
  );

const ProjectedPullRequest = Schema.Struct({
  baseRefOid: CommitSha,
  headRefOid: CommitSha,
  reviewDecision: Schema.NullOr(Schema.String),
  statusCheckRollup: Schema.NullOr(Schema.Struct({ state: Schema.String })),
});
const decodeProjectedPullRequest = Schema.decodeUnknownOption(ProjectedPullRequest);

export const taskPullRequestState = (payload: Schema.Json): Option.Option<TaskPullRequestState> =>
  Option.map(decodeProjectedPullRequest(payload), (payload) =>
    TaskPullRequestState.make({
      base: payload.baseRefOid,
      head: payload.headRefOid,
      checks: payload.statusCheckRollup?.state ?? null,
      review: payload.reviewDecision,
    }),
  );
