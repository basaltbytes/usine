import { Schema } from "effect";
import { AttemptFailure, isAutoRetryable } from "./AttemptFailure.ts";
import { RunId } from "./Run.ts";
import { StepName } from "./Step.ts";

/**
 * Identity of one Attempt.
 */
export const AttemptId = Schema.NonEmptyString.pipe(Schema.brand("AttemptId"));
export type AttemptId = typeof AttemptId.Type;

/**
 * 1-based position of a try under its step: retries are attempt N+1 under the
 * same step, never new runs.
 */
export const AttemptNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("AttemptNumber"),
);
export type AttemptNumber = typeof AttemptNumber.Type;

/** The attempt finished; the step result is stored on the Step. */
export class Succeeded extends Schema.TaggedClass<Succeeded>("AttemptOutcome/Succeeded")(
  "Succeeded",
  {},
) {}

/** The attempt failed, with the typed failure that closed it. */
export class Failed extends Schema.TaggedClass<Failed>("AttemptOutcome/Failed")("Failed", {
  failure: AttemptFailure,
}) {}

export const Outcome = Schema.Union([Succeeded, Failed]);
export type Outcome = typeof Outcome.Type;

/**
 * One try of a step on a worker. `outcome` is none while the attempt is in
 * flight.
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
 * The auto-retry law over one failed attempt (ADR 0002, ADR 0013): only infra
 * failures retry automatically, and only while the attempt count is under the
 * cap. Everything else waits for the operator.
 */
export const shouldAutoRetry = (options: {
  readonly failure: AttemptFailure;
  readonly number: AttemptNumber;
  readonly maxAutoAttempts: AttemptNumber;
}): boolean => isAutoRetryable(options.failure) && options.number < options.maxAutoAttempts;
