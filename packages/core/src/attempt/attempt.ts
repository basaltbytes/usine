import { Schema } from "effect";
import { BrainSpec, ModelId } from "../agent/brain.ts";
import { RunId } from "../run/run.ts";
import { StepName } from "../step/step.ts";
import { WorkerName } from "../worker.ts";
import { AttemptFailure, isAutoRetryableFailure } from "./failure.ts";
import { AttemptOutcome } from "./outcome.ts";

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

/** One try of a step on a worker. `outcome` is none while the attempt is in flight. */
export class Attempt extends Schema.Class<Attempt>("Attempt")({
  id: AttemptId,
  runId: RunId,
  stepName: StepName,
  worker: WorkerName,
  number: AttemptNumber,
  brain: BrainSpec,
  parentModel: Schema.OptionFromNullOr(ModelId),
  startedAt: Schema.DateTimeUtc,
  outcome: Schema.Option(AttemptOutcome),
}) {}

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
