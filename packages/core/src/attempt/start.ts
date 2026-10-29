import { Schema } from "effect";
import { OperatorLogin } from "../operator.ts";

/** A start by the Run's Event, as for every Run's first Attempt. */
export class StartedByEvent extends Schema.TaggedClass<StartedByEvent>("AttemptStart/Event")(
  "Event",
  {},
) {}

/** An operator retry of the failed Run; `operator` is `None` if `usine.yaml` sets no operator login. */
export class StartedByRetry extends Schema.TaggedClass<StartedByRetry>("AttemptStart/Retry")(
  "OperatorRetry",
  { operator: Schema.OptionFromNullOr(OperatorLogin) },
) {}

/**
 * An operator retry of the failed Run with a changed task or Agent (ADR 0018). `operator` is
 * `None` if `usine.yaml` sets no operator login.
 */
export class StartedByEditAndRetry extends Schema.TaggedClass<StartedByEditAndRetry>(
  "AttemptStart/EditAndRetry",
)("EditAndRetry", { operator: Schema.OptionFromNullOr(OperatorLogin) }) {}

/** An automatic retry after the previous Attempt's `InfraFailure` (ADR 0002). */
export class StartedByInfraRetry extends Schema.TaggedClass<StartedByInfraRetry>(
  "AttemptStart/InfraRetry",
)("InfraRetry", {}) {}

/** An automatic retry after a provider capacity refusal and its backoff. */
export class StartedByProviderRetry extends Schema.TaggedClass<StartedByProviderRetry>(
  "AttemptStart/ProviderRetry",
)("ProviderRetry", {}) {}

/** A start after an orchestrator restart interrupted the previous Attempt without a reattach. */
export class StartedAfterRestart extends Schema.TaggedClass<StartedAfterRestart>(
  "AttemptStart/AfterRestart",
)("AfterRestart", {}) {}

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
