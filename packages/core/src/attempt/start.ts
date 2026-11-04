import { type Brand, Schema } from "effect";
import { OperatorActor } from "../operator.ts";

/** A start by the Run's Event, as for every Run's first Attempt. */
export class StartedByEvent extends Schema.TaggedClass<
  StartedByEvent,
  Brand.Brand<"@usine/core/attempt/start/StartedByEvent">
>("AttemptStart/Event")("Event", {}) {}

/** An operator retry of the failed Run; `operator` is `None` if no login was recorded. */
export class StartedByRetry extends Schema.TaggedClass<
  StartedByRetry,
  Brand.Brand<"@usine/core/attempt/start/StartedByRetry">
>("AttemptStart/Retry")("OperatorRetry", {
  /** The operator who requested the retry, or `None` if no login was recorded. */
  operator: Schema.OptionFromNullOr(OperatorActor),
}) {}

/**
 * An operator retry of the failed Run with a changed task or Agent (ADR 0018). `operator` is
 * `None` if no login was recorded.
 */
export class StartedByEditAndRetry extends Schema.TaggedClass<
  StartedByEditAndRetry,
  Brand.Brand<"@usine/core/attempt/start/StartedByEditAndRetry">
>("AttemptStart/EditAndRetry")("EditAndRetry", {
  /** The operator who changed the task or agent and requested the retry, or `None` if unavailable. */
  operator: Schema.OptionFromNullOr(OperatorActor),
}) {}

/** An automatic retry after the previous Attempt's `InfraFailure` (ADR 0002). */
export class StartedByInfraRetry extends Schema.TaggedClass<
  StartedByInfraRetry,
  Brand.Brand<"@usine/core/attempt/start/StartedByInfraRetry">
>("AttemptStart/InfraRetry")("InfraRetry", {}) {}

/** An automatic retry after a provider capacity refusal and its backoff. */
export class StartedByProviderRetry extends Schema.TaggedClass<
  StartedByProviderRetry,
  Brand.Brand<"@usine/core/attempt/start/StartedByProviderRetry">
>("AttemptStart/ProviderRetry")("ProviderRetry", {}) {}

/** A start after an orchestrator restart interrupted the previous Attempt without a reattach. */
export class StartedAfterRestart extends Schema.TaggedClass<
  StartedAfterRestart,
  Brand.Brand<"@usine/core/attempt/start/StartedAfterRestart">
>("AttemptStart/AfterRestart")("AfterRestart", {}) {}

/** An operator retry, with or without a changed task or agent. */
export const OperatorRetryStart = Schema.Union([StartedByRetry, StartedByEditAndRetry]);
export type OperatorRetryStart = typeof OperatorRetryStart.Type;

/** The reason an Attempt started; a reattached Attempt keeps its original reason. */
export const AttemptStart = Schema.Union([
  StartedByEvent,
  StartedByRetry,
  StartedByEditAndRetry,
  StartedByInfraRetry,
  StartedByProviderRetry,
  StartedAfterRestart,
]);
export type AttemptStart = typeof AttemptStart.Type;
