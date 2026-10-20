import { Schema } from "effect";
import { OperatorLogin } from "../operator.ts";

/** The Run's Event began the Attempt; every Run's first Attempt starts this way. */
export class StartedByEvent extends Schema.TaggedClass<StartedByEvent>("AttemptStart/Event")(
  "Event",
  {},
) {}

/**
 * The operator retried the failed Run. `operator` is the login that asked, none
 * while `usine.yaml` names no operator.
 */
export class StartedByRetry extends Schema.TaggedClass<StartedByRetry>("AttemptStart/Retry")(
  "OperatorRetry",
  { operator: Schema.OptionFromNullOr(OperatorLogin) },
) {}

/**
 * The operator amended the failed Run's task or Agent and retried it (ADR 0018).
 * `operator` is the login that asked, none while `usine.yaml` names no operator.
 */
export class StartedByEditAndRetry extends Schema.TaggedClass<StartedByEditAndRetry>(
  "AttemptStart/EditAndRetry",
)("EditAndRetry", { operator: Schema.OptionFromNullOr(OperatorLogin) }) {}

/** The engine retried on its own after the previous Attempt's infrastructure failure (ADR 0002). */
export class StartedByInfraRetry extends Schema.TaggedClass<StartedByInfraRetry>(
  "AttemptStart/InfraRetry",
)("InfraRetry", {}) {}

/**
 * An orchestrator restart interrupted the previous Attempt, and its parent task
 * did not survive to be reattached, so this Attempt took its place.
 */
export class StartedAfterRestart extends Schema.TaggedClass<StartedAfterRestart>(
  "AttemptStart/AfterRestart",
)("AfterRestart", {}) {}

/** The operator's request that begins a failed Run's next Attempt. */
export const OperatorRetryStart = Schema.Union([StartedByRetry, StartedByEditAndRetry]);
export type OperatorRetryStart = typeof OperatorRetryStart.Type;

/** Why an Attempt began. A reattached Attempt keeps the reason it began with. */
export const AttemptStart = Schema.Union([
  StartedByEvent,
  StartedByRetry,
  StartedByEditAndRetry,
  StartedByInfraRetry,
  StartedAfterRestart,
]);
export type AttemptStart = typeof AttemptStart.Type;
