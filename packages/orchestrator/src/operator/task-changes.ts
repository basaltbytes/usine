import { AttemptId, AttemptNumber } from "@usine/core/attempt";
import { ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { CommitSha } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import type { RunSnapshot } from "@usine/engine/run-reader";
import { type Brand, Array as EffectArray, Option, Schema } from "effect";

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

/** A successful attempt's recorded commits associated with one pull request. */
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
): ReadonlyArray<TaskAttemptChangesView> => {
  if (Option.isNone(snapshot.step.result)) return [];
  const attempt = EffectArray.findLast(snapshot.attempts, ({ outcome }) =>
    Option.exists(
      outcome,
      ({ _tag }) => _tag === "Succeeded" || _tag === "AwaitingCi" || _tag === "HandedOff",
    ),
  );
  if (Option.isNone(attempt)) return [];
  const facts = snapshot.step.result.value.facts;
  return facts.flatMap((fact) => {
    if (fact._tag !== "PullRequest" || Option.isNone(fact.base) || Option.isNone(fact.head))
      return [];
    return [
      TaskAttemptChangesView.make({
        runId: snapshot.run.id,
        attemptId: attempt.value.id,
        number: attempt.value.number,
        loop: snapshot.run.loop,
        pullRequest: ItemNumber.make(fact.number),
        base: fact.base.value,
        head: fact.head.value,
      }),
    ];
  });
};

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
