import { Array as EffectArray, DateTime, Effect, Option, Schema } from "effect";
import { Agent, AgentName } from "../agent/agent.ts";
import { BrainSpec, ModelId } from "../agent/brain.ts";
import { closedStruct } from "../closed-struct.ts";
import { OperatorLogin } from "../operator.ts";
import type { RunState } from "../run/state.ts";
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

/** The total attempt cap for automatic retries, including the first try. */
export const MAX_AUTO_ATTEMPTS = AttemptNumber.make(3);

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
  /** The effective task text for subsequent attempts in the run. */
  task: AttemptTask,
  /** The agent definition selected for subsequent attempts. */
  agent: Agent,
  /** The effective Pi parent model, or `None` to let Pi select it. */
  parentModel: Schema.OptionFromNullOr(ModelId),
}) {}

/** An operator's resolution of a failed attempt; the login is absent if none was recorded. */
export class FailureResolution extends Schema.Class<FailureResolution>("FailureResolution")(
  closedStruct({
    /** The time the operator marked the attempt's failure resolved. */
    resolvedAt: Schema.DateTimeUtcFromString,
    /** The operator login attributed to the resolution, or `None` if unavailable. */
    operator: Schema.OptionFromNullOr(OperatorLogin),
  }),
) {}

const Kills = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/**
 * The processes that the kernel killed in an Attempt's containers because a container reached
 * its memory limit, `memoryMib`: the limit of the last container that recorded kills.
 */
export class OutOfMemoryKills extends Schema.Class<OutOfMemoryKills>("OutOfMemoryKills")({
  /** The total processes the kernel killed across the attempt's containers. */
  kills: Kills,
  /** The memory limit, in MiB, of the last container that recorded kills. */
  memoryMib: ContainerMemoryMib,
}) {}

/**
 * The processes that the kernel killed in one of an Attempt's containers, `container`, because it
 * reached its memory limit, `memoryMib`. A reattachment runs the Attempt in a new container.
 */
export class ContainerOutOfMemoryKills extends Schema.Class<ContainerOutOfMemoryKills>(
  "ContainerOutOfMemoryKills",
)({
  /** The runtime ID of the container that recorded the kills. */
  container: ContainerId,
  /** The cumulative processes the kernel killed in this container. */
  kills: Kills,
  /** This container's memory limit in MiB. */
  memoryMib: ContainerMemoryMib,
}) {}

/** Returns the kills in `containers` together, with the memory limit of the last one. */
export const totalOutOfMemoryKills = (
  containers: EffectArray.NonEmptyReadonlyArray<ContainerOutOfMemoryKills>,
): OutOfMemoryKills =>
  new OutOfMemoryKills({
    kills: containers.reduce((total, { kills }) => total + kills, 0),
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
  /** The identity of this try, distinct from every retry. */
  id: AttemptId,
  /** The run whose step this attempt tries. */
  runId: RunId,
  /** The step name under which the run stores a successful result. */
  stepName: StepName,
  /** The worker assigned to this attempt. */
  worker: WorkerName,
  /** The 1-based position of this attempt in the step, including automatic retries. */
  number: AttemptNumber,
  /** The child-session brain settings recorded for this attempt. */
  brain: BrainSpec,
  /** The effective task text supplied when this attempt started. */
  task: AttemptTask,
  /** The agent selected for this attempt. */
  agent: AgentName,
  /** Whether an operator action was accepted during this attempt. */
  operatorIntervened: Schema.Boolean,
  /** The Pi parent model recorded for this attempt, or `None` if unavailable. */
  parentModel: Schema.OptionFromNullOr(ModelId),
  /** The time this attempt started, also the start of its attribution window. */
  startedAt: Schema.DateTimeUtc,
  /** The terminal result, or `None` while the attempt is open. */
  outcome: Schema.Option(AttemptOutcome),
  /** The time the outcome was recorded, or `None` while open or for older records. */
  endedAt: Schema.Option(Schema.DateTimeUtc),
  /** The workspace recovery result after an unsuccessful end, or `None` if none was recorded. */
  salvage: Schema.Option(AttemptSalvage),
  /** The operator's recorded failure resolution, or `None` for unresolved or older records. */
  failureResolution: Schema.Option(FailureResolution).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none<FailureResolution>())),
  ),
  /** The reason this attempt started, or `None` for older records. */
  start: Schema.Option(AttemptStart).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none<AttemptStart>())),
  ),
  /** The most recent restart reattachment time, or `None` if never reattached. */
  reattachedAt: Schema.Option(Schema.DateTimeUtc).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none())),
  ),
  /** Comments and reviews from an unsuccessful attempt; successful attempts record them in the step result. */
  comments: Schema.Array(Comment).pipe(Schema.withConstructorDefault(Effect.succeed([]))),
  /** The memory-related process kills across this attempt's containers, or `None` if none were recorded. */
  outOfMemory: Schema.Option(OutOfMemoryKills).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none<OutOfMemoryKills>())),
  ),
}) {}

/**
 * The time span of an Attempt, open while `endedAt` is `None`, used to attribute GitHub writes
 * by Attempts that share one App login.
 */
export class AttemptWindow extends Schema.Class<AttemptWindow>("AttemptWindow")({
  /** The attempt to which writes in this window may belong. */
  attemptId: AttemptId,
  /** The start time, rounded down to the second when comparing GitHub timestamps. */
  startedAt: Schema.DateTimeUtc,
  /** The inclusive end time, or `None` while the window remains open. */
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
  /** The harvested attempt's window, or `None` when older records lack its end time. */
  own: Schema.Option(AttemptWindow),
  /** Other attempts by the same agent on the same item whose windows overlap this one. */
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

/** The next attempt after a provider capacity refusal, with its earliest start time. */
export class ProviderRetry extends Schema.Class<ProviderRetry>("ProviderRetry")(
  closedStruct({
    /** The 1-based number of the attempt to start after the refusal. */
    nextAttempt: AttemptNumber.check(Schema.isGreaterThanOrEqualTo(2)),
    /** The earliest permitted retry time after the provider backoff. */
    retryAt: Schema.DateTimeUtcFromString,
    /** The provider capacity refusal reported by the previous attempt. */
    message: Schema.NonEmptyString,
  }),
) {}

/**
 * Returns a pending capacity retry from persisted state, including after an orchestrator restart.
 * `attempts` must be ordered oldest to newest. Returns `None` unless the run is running and its
 * latest attempt has a recorded end time and a capacity failure below the automatic retry cap.
 * The retry starts no earlier than two minutes after attempt 1 or five minutes after attempt 2.
 */
export const pendingProviderRetry = (
  state: RunState,
  attempts: ReadonlyArray<Attempt>,
): Option.Option<ProviderRetry> => {
  if (state._tag !== "Running") return Option.none();
  const last = attempts.at(-1);
  if (
    last === undefined ||
    last.number >= MAX_AUTO_ATTEMPTS ||
    Option.isNone(last.outcome) ||
    Option.isNone(last.endedAt)
  )
    return Option.none();
  const outcome = last.outcome.value;
  if (outcome._tag !== "Failed" || outcome.failure._tag !== "ProviderCapacityFailure")
    return Option.none();
  return Option.some(
    new ProviderRetry({
      nextAttempt: AttemptNumber.make(last.number + 1),
      retryAt: DateTime.add(last.endedAt.value, {
        minutes: last.number === 1 ? 2 : 5,
      }),
      message: outcome.failure.message,
    }),
  );
};
