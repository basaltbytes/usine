import { DateTime, Effect, Option, Schema } from "effect";
import { Agent, AgentName } from "../agent/agent.ts";
import { BrainSpec, ModelId } from "../agent/brain.ts";
import { RunId } from "../run/run.ts";
import { Comment } from "../step/result.ts";
import { StepName } from "../step/step.ts";
import { WorkerName } from "../worker.ts";
import { AttemptFailure, isAutoRetryableFailure } from "./failure.ts";
import { AttemptOutcome } from "./outcome.ts";
import { AttemptSalvage } from "./salvage.ts";
import { AttemptStart } from "./start.ts";

/** Identity of one execution try; each retry receives a new identity under the same Run and Step. */
export const AttemptId = Schema.NonEmptyString.pipe(Schema.brand("AttemptId"));

export type AttemptId = typeof AttemptId.Type;

/**
 * 1-based position of a try under its step. Retries are attempt N+1 under the
 * same step, and the auto-retry cap counts total attempts.
 */
export const AttemptNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("AttemptNumber"),
);
export type AttemptNumber = typeof AttemptNumber.Type;

/** Task text given to the agent after loop interpolation or an operator's edit-and-retry amendment. */
export const AttemptTask = Schema.String.check(
  Schema.isPattern(/\S/u, { message: "Expected non-blank task text" }),
).pipe(Schema.brand("AttemptTask"));
export type AttemptTask = typeof AttemptTask.Type;

/** The effective task and roster Agent an operator assigns to a Run's later Attempts. */
export class AttemptContext extends Schema.Class<AttemptContext>("AttemptContext")({
  task: AttemptTask,
  agent: Agent,
  parentModel: Schema.OptionFromNullOr(ModelId),
}) {}

/**
 * One try of a step on a worker. `outcome` is none while the attempt is in flight.
 * `endedAt` is when the outcome was recorded; it is none while the attempt is in
 * flight and for attempts closed before end times were recorded.
 * `salvage` records what the executor preserved of the workspace after an
 * unsuccessful end; the next attempt of the same Run resumes from a pushed salvage.
 * `start` is why the attempt began, none for attempts begun before it was
 * recorded, and `reattachedAt` is when an orchestrator restart last reattached
 * it, none if none did. `comments` are the comments and reviews the attempt
 * posted on its Run's Item before it ended without success; a succeeded
 * attempt's are facts of its Step result instead.
 */
export class Attempt extends Schema.Class<Attempt>("Attempt")({
  id: AttemptId,
  runId: RunId,
  stepName: StepName,
  worker: WorkerName,
  number: AttemptNumber,
  brain: BrainSpec,
  task: AttemptTask,
  agent: AgentName,
  operatorIntervened: Schema.Boolean,
  parentModel: Schema.OptionFromNullOr(ModelId),
  startedAt: Schema.DateTimeUtc,
  outcome: Schema.Option(AttemptOutcome),
  endedAt: Schema.Option(Schema.DateTimeUtc),
  salvage: Schema.Option(AttemptSalvage),
  start: Schema.Option(AttemptStart).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none<AttemptStart>())),
  ),
  reattachedAt: Schema.Option(Schema.DateTimeUtc).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none())),
  ),
  comments: Schema.Array(Comment).pipe(Schema.withConstructorDefault(Effect.succeed([]))),
}) {}

/**
 * When an Attempt was at work on its Run's Item, from its record: from
 * `startedAt` through `endedAt`, which is none while the Attempt is open.
 * Every Attempt on a local or SSH Worker writes to GitHub as the same App, so
 * only these windows tell their writes apart.
 */
export class AttemptWindow extends Schema.Class<AttemptWindow>("AttemptWindow")({
  attemptId: AttemptId,
  startedAt: Schema.DateTimeUtc,
  endedAt: Schema.Option(Schema.DateTimeUtc),
}) {}

/**
 * The window `attempt`'s record gives it. None for an Attempt that ended
 * before end times were recorded: its end is unknown.
 */
export const windowOf = (attempt: Attempt): Option.Option<AttemptWindow> =>
  Option.isSome(attempt.outcome) && Option.isNone(attempt.endedAt)
    ? Option.none()
    : Option.some(
        new AttemptWindow({
          attemptId: attempt.id,
          startedAt: attempt.startedAt,
          endedAt: attempt.endedAt,
        }),
      );

/**
 * The first moment GitHub records as inside `window`. GitHub records times to
 * the second, so a window opens at the second its Attempt started.
 */
const opening = (window: AttemptWindow) => {
  const start = DateTime.toEpochMillis(window.startedAt);
  return start - (start % 1_000);
};

/** Whether `window` is still open at `millis`, or ended at it or later. */
const reaches = (window: AttemptWindow, millis: number) =>
  Option.match(window.endedAt, {
    onNone: () => true,
    onSome: (end) => millis <= DateTime.toEpochMillis(end),
  });

/** Whether GitHub's time `at`, recorded to the second, falls in `window`. */
export const windowHolds = (window: AttemptWindow, at: DateTime.Utc): boolean => {
  const time = DateTime.toEpochMillis(at);
  return opening(window) <= time && reaches(window, time);
};

/**
 * Whether GitHub can record a time that both windows hold, so that a write
 * their Attempts could each have made at that time belongs to neither.
 */
export const windowsOverlap = (left: AttemptWindow, right: AttemptWindow): boolean =>
  reaches(left, opening(right)) && reaches(right, opening(left));

/**
 * The auto-retry law: only an infra failure retries, and only while the attempt
 * number is below `maxAutoAttempts` (ADR 0002).
 * `number` is the failed try's position; `maxAutoAttempts` includes the first try.
 */
export const shouldAutoRetry = (options: {
  readonly failure: AttemptFailure;
  readonly number: AttemptNumber;
  readonly maxAutoAttempts: AttemptNumber;
}): boolean => isAutoRetryableFailure(options.failure) && options.number < options.maxAutoAttempts;
