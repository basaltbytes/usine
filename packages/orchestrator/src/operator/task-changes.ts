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
  first: CommitSha,
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
  const commits = facts.filter((fact) => fact._tag === "Commit");
  const first = commits[0];
  const last = commits.at(-1);
  if (first === undefined || last === undefined) return [];
  return facts.flatMap((fact) =>
    fact._tag === "PullRequest"
      ? [
          TaskAttemptChangesView.make({
            runId: snapshot.run.id,
            attemptId: attempt.value.id,
            number: attempt.value.number,
            loop: snapshot.run.loop,
            pullRequest: ItemNumber.make(fact.number),
            first: first.sha,
            head: Option.getOrElse(fact.head, () => last.sha),
          }),
        ]
      : [],
  );
};

const ProjectedPullRequest = Schema.Struct({
  headRefOid: CommitSha,
  reviewDecision: Schema.NullOr(Schema.String),
  statusCheckRollup: Schema.NullOr(Schema.Struct({ state: Schema.String })),
});
const decodeProjectedPullRequest = Schema.decodeUnknownOption(ProjectedPullRequest);

export const taskPullRequestState = (payload: Schema.Json): Option.Option<TaskPullRequestState> =>
  Option.map(decodeProjectedPullRequest(payload), (payload) =>
    TaskPullRequestState.make({
      head: payload.headRefOid,
      checks: payload.statusCheckRollup?.state ?? null,
      review: payload.reviewDecision,
    }),
  );
