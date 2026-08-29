import { Schema } from "effect";
import { AttemptFailure, isAutoRetryable } from "./attempt-failure.ts";
import { RunId } from "./run.ts";
import { StepName } from "./step.ts";

/**
 * Value object (branded id): identity of one Attempt.
 */
export const AttemptId = Schema.NonEmptyString.pipe(Schema.brand("AttemptId"));
export type AttemptId = typeof AttemptId.Type;

/**
 * Value object: 1-based position of a try under its step — retries are
 * attempt N+1 under the same step, never new runs. Also the unit of the
 * auto-retry cap: a cap of 3 means at most three attempts in total.
 */
export const AttemptNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("AttemptNumber"),
);
export type AttemptNumber = typeof AttemptNumber.Type;

/** Outcome — value object: the attempt finished; the step result is stored on the Step. */
export class Succeeded extends Schema.TaggedClass<Succeeded>("AttemptOutcome/Succeeded")(
  "Succeeded",
  {},
) {}

/** Outcome — value object: the attempt failed, with the typed failure that closed it. */
export class Failed extends Schema.TaggedClass<Failed>("AttemptOutcome/Failed")("Failed", {
  failure: AttemptFailure,
}) {}

/** Outcome — value object: the operator canceled the Run during this Attempt. */
export class Canceled extends Schema.TaggedClass<Canceled>("AttemptOutcome/Canceled")(
  "Canceled",
  {},
) {}

export const Outcome = Schema.Union([Succeeded, Failed, Canceled]);
export type Outcome = typeof Outcome.Type;

/**
 * Entity — ledger row: one try of a step on a worker. `outcome` is none while
 * the attempt is in flight.
 */
export class Attempt extends Schema.Class<Attempt>("Attempt")({
  id: AttemptId,
  runId: RunId,
  stepName: StepName,
  number: AttemptNumber,
  startedAt: Schema.DateTimeUtc,
  outcome: Schema.Option(Outcome),
}) {}

/**
 * Deriver — the full auto-retry law over one failed attempt (ADR 0002,
 * ADR 0013): the class rule (`AttemptFailure.isAutoRetryable` — infra only)
 * capped by the attempt count. `maxAutoAttempts` counts total attempts:
 * attempt N may auto-retry into attempt N+1 only while N < maxAutoAttempts.
 */
export const shouldAutoRetry = (options: {
  readonly failure: AttemptFailure;
  readonly number: AttemptNumber;
  readonly maxAutoAttempts: AttemptNumber;
}): boolean => isAutoRetryable(options.failure) && options.number < options.maxAutoAttempts;
