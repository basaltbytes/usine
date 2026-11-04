import { type Brand, Option, Result, Schema } from "effect";
import { AgentFailure } from "./attempt/failure.ts";
import { ItemNumber } from "./item.ts";
import { LoopName } from "./loop.ts";
import { RunId } from "./run/id.ts";
import { CommitSha } from "./repository.ts";

/** The final-answer marker that transfers CI waiting to the orchestrator. */
export const AWAITING_CI_MARKER = "[usine:awaiting-ci]";

const Labels = Schema.Array(Schema.NonEmptyString).check(Schema.isUnique());

/** Labels to change on one item in the run's repository after CI passes. */
export class CiLabelMutation extends Schema.Class<
  CiLabelMutation,
  Brand.Brand<"@usine/core/ci/CiLabelMutation">
>("CiLabelMutation")({
  item: ItemNumber,
  add: Labels,
  remove: Labels,
}) {}

/** The CI requirement configured on a loop and saved when its event matches. */
export class CiPolicy extends Schema.Class<CiPolicy, Brand.Brand<"@usine/core/ci/CiPolicy">>(
  "CiPolicy",
)({
  fixLoop: LoopName,
  timeoutSeconds: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(86400)),
}) {}

/** The pushed head, fix loop, deadline, and completion actions recorded by an agent. */
export class CiHandoff extends Schema.Class<CiHandoff, Brand.Brand<"@usine/core/ci/CiHandoff">>(
  "CiHandoff",
)({
  pullRequest: ItemNumber,
  head: CommitSha,
  ...CiPolicy.fields,
  onGreen: Schema.Array(CiLabelMutation),
}) {}

const HandoffFromJson = Schema.fromJsonString(
  CiHandoff.pipe(
    Schema.encodeKeys({
      pullRequest: "pull_request",
      fixLoop: "fix_loop",
      timeoutSeconds: "timeout_seconds",
      onGreen: "on_green",
    }),
  ),
);

/** Decodes a handoff following the marker, or returns `None` for an ordinary final answer. */
export const ciHandoff = (
  message: string,
): Result.Result<Option.Option<CiHandoff>, AgentFailure> => {
  const answer = message.trim();
  if (!answer.startsWith(AWAITING_CI_MARKER)) return Result.succeed(Option.none());
  return Schema.decodeResult(HandoffFromJson)(answer.slice(AWAITING_CI_MARKER.length).trim(), {
    onExcessProperty: "error",
  }).pipe(
    Result.map(Option.some),
    Result.mapError((error) =>
      AgentFailure.make({ message: `Invalid CI handoff: ${error.message}` }),
    ),
  );
};

/** CI passed for the recorded head. */
export class CiPassed extends Schema.TaggedClass<
  CiPassed,
  Brand.Brand<"@usine/core/ci/CiPassed">
>()("CiPassed", {}) {}

/** CI failed or exceeded its deadline. */
export class CiFailed extends Schema.TaggedClass<
  CiFailed,
  Brand.Brand<"@usine/core/ci/CiFailed">
>()("CiFailed", {
  message: Schema.NonEmptyString,
}) {}

/** Failed CI accepted by a fix run. */
export class CiHandedOff extends Schema.TaggedClass<
  CiHandedOff,
  Brand.Brand<"@usine/core/ci/CiHandedOff">
>()("CiHandedOff", {
  reason: Schema.NonEmptyString,
  fixRunId: RunId,
}) {}

/** A different head replaced the recorded push. */
export class CiSuperseded extends Schema.TaggedClass<
  CiSuperseded,
  Brand.Brand<"@usine/core/ci/CiSuperseded">
>()("CiSuperseded", {
  head: CommitSha,
}) {}

/** A terminal observation of the recorded head's CI. */
export const CiResolution = Schema.Union([CiPassed, CiFailed, CiHandedOff, CiSuperseded]);
export type CiResolution = typeof CiResolution.Type;
