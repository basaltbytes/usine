import { Array as EffectArray, DateTime, Effect, Option, Schema } from "effect";
import { Agent, AgentName } from "../agent/agent.ts";
import { BrainSpec, ModelId } from "../agent/brain.ts";
import { RunId } from "../run/run.ts";
import { Comment } from "../step/result.ts";
import { StepName } from "../step/step.ts";
import { ContainerId, ContainerMemoryMib, WorkerName } from "../worker.ts";
import { AttemptFailure, isAutoRetryableFailure } from "./failure.ts";
import { AttemptOutcome } from "./outcome.ts";
import { AttemptSalvage } from "./salvage.ts";
import { AttemptStart } from "./start.ts";

/** The ID of an Attempt; each retry gets a new ID under the same Run and Step. */
export const AttemptId = Schema.NonEmptyString.pipe(Schema.brand("AttemptId"));

export type AttemptId = typeof AttemptId.Type;

/** The 1-based position of the Attempt in its Step. */
export const AttemptNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("AttemptNumber"),
);
export type AttemptNumber = typeof AttemptNumber.Type;

/** The task text for the agent: the interpolated loop prompt or the operator's edit-and-retry text. */
export const AttemptTask = Schema.String.check(
  Schema.isPattern(/\S/u, { message: "Expected non-blank task text" }),
).pipe(Schema.brand("AttemptTask"));
export type AttemptTask = typeof AttemptTask.Type;

/**
 * Why the engine stops an Attempt's parent task: the operator canceled the Attempt (`cancel`), the
 * Attempt failed (`failed`), or startup found the Attempt closed or not reattached (`startup`).
 */
export const StopReason = Schema.Literals(["cancel", "failed", "startup"]);
export type StopReason = typeof StopReason.Type;

/** The task and Agent that an operator sets for a Run's later Attempts. */
export class AttemptContext extends Schema.Class<AttemptContext>("AttemptContext")({
  task: AttemptTask,
  agent: Agent,
  parentModel: Schema.OptionFromNullOr(ModelId),
}) {}

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/**
 * The processes that the kernel killed for memory in an Attempt's containers, all of them
 * together.
 *
 * - `containers`: how many of the Attempt's containers had kills.
 * - `memoryMib`: the memory limit of the last container that had kills. The kills of an earlier
 *   container can have happened at another limit.
 */
export class OutOfMemoryKills extends Schema.Class<OutOfMemoryKills>("OutOfMemoryKills")({
  kills: PositiveInt,
  containers: PositiveInt,
  memoryMib: ContainerMemoryMib,
}) {}

/**
 * The processes that the kernel killed in one of an Attempt's containers, `container`, because it
 * reached its memory limit, `memoryMib`. A reattachment runs the Attempt in a new container.
 */
export class ContainerOutOfMemoryKills extends Schema.Class<ContainerOutOfMemoryKills>(
  "ContainerOutOfMemoryKills",
)({
  container: ContainerId,
  kills: PositiveInt,
  memoryMib: ContainerMemoryMib,
}) {}

/**
 * Returns the kills in `containers` together, with the memory limit of the last one. Each entry
 * of `containers` is a different container.
 */
export const totalOutOfMemoryKills = (
  containers: EffectArray.NonEmptyReadonlyArray<ContainerOutOfMemoryKills>,
): OutOfMemoryKills =>
  new OutOfMemoryKills({
    kills: containers.reduce((total, { kills }) => total + kills, 0),
    containers: containers.length,
    memoryMib: EffectArray.lastNonEmpty(containers).memoryMib,
  });

/**
 * One try of a Step on a Worker.
 *
 * - `outcome`: `None` while the Attempt runs.
 * - `endedAt`: the time the outcome was recorded; `None` while running and for older records.
 * - `salvage`: what the executor kept of the workspace after an unsuccessful end.
 * - `start`: the reason the Attempt started; `None` for older records.
 * - `reattachedAt`: the last time an orchestrator restart reattached the Attempt.
 * - `comments`: the comments and reviews posted by an unsuccessful Attempt; a successful
 *   Attempt's are in the Step result.
 * - `outOfMemory`: the processes the kernel killed in the Attempt's containers for memory, in all
 *   of them together; `None` if it killed none or the Attempt ran without a container.
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
  outOfMemory: Schema.Option(OutOfMemoryKills).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none<OutOfMemoryKills>())),
  ),
}) {}

/**
 * The time span of an Attempt, open while `endedAt` is `None`, used to attribute GitHub writes
 * by Attempts that share one App login.
 */
export class AttemptWindow extends Schema.Class<AttemptWindow>("AttemptWindow")({
  attemptId: AttemptId,
  startedAt: Schema.DateTimeUtc,
  endedAt: Schema.Option(Schema.DateTimeUtc),
}) {}

/** Returns the Attempt's window, or `None` if it ended before end times were recorded. */
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

/** Returns the window start truncated to the second, the precision of GitHub timestamps. */
const opening = (window: AttemptWindow) => {
  const start = DateTime.toEpochMillis(window.startedAt);
  return start - (start % 1_000);
};

/** Returns whether `window` is open or ended at or after `millis`. */
const reaches = (window: AttemptWindow, millis: number) =>
  Option.match(window.endedAt, {
    onNone: () => true,
    onSome: (end) => millis <= DateTime.toEpochMillis(end),
  });

/** Returns whether the GitHub timestamp `at` is inside `window`. */
export const windowHolds = (window: AttemptWindow, at: DateTime.Utc): boolean => {
  const time = DateTime.toEpochMillis(at);
  return opening(window) <= time && reaches(window, time);
};

/** Returns whether a GitHub timestamp can be inside both windows. */
export const windowsOverlap = (left: AttemptWindow, right: AttemptWindow): boolean =>
  reaches(left, opening(right)) && reaches(right, opening(left));

/**
 * The windows used to attribute writes on a Run's Item to one Attempt. A write belongs to the
 * Attempt only if its time is inside `own` and outside every `overlapping` window, which are the
 * same Agent's other Attempts on the Item.
 */
export class AttemptWindows extends Schema.Class<AttemptWindows>("AttemptWindows")({
  own: Schema.Option(AttemptWindow),
  overlapping: Schema.Array(AttemptWindow),
}) {}

/**
 * Returns whether `failure` is retryable and the failed Attempt's `number` is below
 * `maxAutoAttempts`, which counts the first try (ADR 0002).
 */
export const shouldAutoRetry = (options: {
  readonly failure: AttemptFailure;
  readonly number: AttemptNumber;
  readonly maxAutoAttempts: AttemptNumber;
}): boolean => isAutoRetryableFailure(options.failure) && options.number < options.maxAutoAttempts;
