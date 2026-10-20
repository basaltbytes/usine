import { Effect, Option, Schema } from "effect";
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
 * The auto-retry law: only an infra failure retries, and only while the attempt
 * number is below `maxAutoAttempts` (ADR 0002).
 * `number` is the failed try's position; `maxAutoAttempts` includes the first try.
 */
export const shouldAutoRetry = (options: {
  readonly failure: AttemptFailure;
  readonly number: AttemptNumber;
  readonly maxAutoAttempts: AttemptNumber;
}): boolean => isAutoRetryableFailure(options.failure) && options.number < options.maxAutoAttempts;
