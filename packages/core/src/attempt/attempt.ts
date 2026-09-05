import { Schema } from "effect";
import { BrainSpec, ModelId } from "../agent/brain.ts";
import { RunId } from "../run/run.ts";
import { StepName } from "../step/step.ts";
import { WorkerName } from "../worker.ts";
import { AttemptFailure, isAutoRetryableFailure } from "./failure.ts";
import { AttemptOutcome } from "./outcome.ts";

/** Identity of one Attempt. */
export const AttemptId = Schema.NonEmptyString.pipe(Schema.brand("AttemptId"));

export type AttemptId = typeof AttemptId.Type;

/**
 * 1-based position of a try under its step — retries are attempt N+1 under
 * the same step, never new runs. Also the unit of the auto-retry cap: a cap of
 * 3 means at most three attempts in total.
 */
export const AttemptNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("AttemptNumber"),
);
export type AttemptNumber = typeof AttemptNumber.Type;

/** The rendered task text the run host gives the agent. */
export const AttemptTask = Schema.String.check(
  Schema.isPattern(/\S/u, { message: "Expected non-blank task text" }),
).pipe(Schema.brand("AttemptTask"));
export type AttemptTask = typeof AttemptTask.Type;

/**
 * Ledger row: one try of a step on a worker. `outcome` is none while the
 * attempt is in flight.
 */
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
 * The full auto-retry law over one failed attempt (ADR 0002, ADR 0013): the
 * class rule (`isAutoRetryableFailure` — infra only) capped by the attempt
 * count. `maxAutoAttempts` counts total attempts: attempt N may auto-retry
 * into attempt N+1 only while N < maxAutoAttempts.
 */
export const shouldAutoRetry = (options: {
  readonly failure: AttemptFailure;
  readonly number: AttemptNumber;
  readonly maxAutoAttempts: AttemptNumber;
}): boolean => isAutoRetryableFailure(options.failure) && options.number < options.maxAutoAttempts;
