import { Schema } from "effect";
import { EventId } from "../event.ts";

/**
 * The run state machine (ADR 0002):
 *
 *   pending ─────────────────────────► running ──► succeeded
 *      │                               ▲  │
 *      ▼                               │  ▼
 *   waiting ──(approval)──► queued ────┘ failed ──► (retry: attempt N+1) ──► running
 *
 *   pending | waiting | queued | running ──► canceled   (operator cancel)
 *   pending | waiting | queued           ──► canceled   (supersede, revoke: a started
 *                                                        attempt always finishes, ADR 0007)
 *
 * Each transition accepts only its legal source states, so an illegal transition is a type
 * error. States come from the transitions or from decoding a stored row with `RunState`.
 */

export class OperatorCanceled extends Schema.TaggedClass<OperatorCanceled>(
  "CancelReason/OperatorCanceled",
)("OperatorCanceled", {}) {}

/** Cancellation because a newer Event for the same Item arrived before any Attempt started. */
export class Superseded extends Schema.TaggedClass<Superseded>("CancelReason/Superseded")(
  "Superseded",
  { by: EventId },
) {}

/** Cancellation because the Item stopped matching the Loop's trigger before any Attempt started. */
export class Revoked extends Schema.TaggedClass<Revoked>("CancelReason/Revoked")("Revoked", {}) {}

export const CancelReason = Schema.Union([OperatorCanceled, Superseded, Revoked]);
export type CancelReason = typeof CancelReason.Type;

/** A new Run with no Attempt started and no approval gate passed. */
export class Pending extends Schema.TaggedClass<Pending>("RunState/Pending")("Pending", {}) {}

/** A Run waiting for its Loop's approval Event. */
export class Waiting extends Schema.TaggedClass<Waiting>("RunState/Waiting")("Waiting", {}) {}

/** An approved Run waiting for a Worker slot. */
export class Queued extends Schema.TaggedClass<Queued>("RunState/Queued")("Queued", {}) {}

/** A Run with an Attempt running on a Worker. */
export class Running extends Schema.TaggedClass<Running>("RunState/Running")("Running", {}) {}

/** A Run whose Step finished with a stored result. */
export class Succeeded extends Schema.TaggedClass<Succeeded>("RunState/Succeeded")(
  "Succeeded",
  {},
) {}

/** A Run whose last Attempt failed without an auto-retry; the failure is stored on the Attempt. */
export class Failed extends Schema.TaggedClass<Failed>("RunState/Failed")("Failed", {}) {}

export class Canceled extends Schema.TaggedClass<Canceled>("RunState/Canceled")("Canceled", {
  reason: CancelReason,
}) {}

/** The states of a Run that isn't closed. */
export const Open = Schema.Union([Pending, Waiting, Queued, Running]);
export type Open = typeof Open.Type;

export const RunState = Schema.Union([...Open.members, Succeeded, Failed, Canceled]);
export type RunState = typeof RunState.Type;

/** The states before any Attempt starts, accepted by `supersede` and `revoke`. */
export const Unstarted = Schema.Union([Pending, Waiting, Queued]);
export type Unstarted = typeof Unstarted.Type;

/** The states from which an Attempt can start. */
export const Startable = Schema.Union([Pending, Queued]);
export type Startable = typeof Startable.Type;

export const isOpen = Schema.is(Open);
export const isUnstarted = Schema.is(Unstarted);
export const isStartable = Schema.is(Startable);

/** Returns the operator actions allowed in `state`. */
export const operatorActions = (state: RunState) => ({
  canApprove: state._tag === "Waiting",
  canRetry: state._tag === "Failed",
  canResolveFailure: state._tag === "Failed",
  canCancel: isOpen(state),
  canRunAgain: state._tag === "Succeeded" || state._tag === "Canceled",
});

/** Returns its arguments, which must be exactly the `_tag` values of `State`; a missing or extra tag is a type error. */
const tagsOf =
  <State extends RunState>() =>
  <const Tags extends ReadonlyArray<State["_tag"]>>(
    ...tags: [State["_tag"]] extends [Tags[number]] ? Tags : [never]
  ) =>
    tags;

/** The `_tag` values of `Open`, for SQL filters. */
export const OPEN_STATE_TAGS = tagsOf<Open>()("Pending", "Waiting", "Queued", "Running");

/** The `_tag` values of `RunState`. */
export const STATE_TAGS = tagsOf<RunState>()(
  "Pending",
  "Waiting",
  "Queued",
  "Running",
  "Succeeded",
  "Failed",
  "Canceled",
);

/** The `_tag` values of `Unstarted`, for SQL filters. */
export const UNSTARTED_STATE_TAGS = tagsOf<Unstarted>()("Pending", "Waiting", "Queued");

export const awaitApproval = (_state: Pending): Waiting => new Waiting();

export const approve = (_state: Waiting): Queued => new Queued();

export const start = (_state: Startable): Running => new Running();

export const succeed = (_state: Running): Succeeded => new Succeeded();

/** Returns `Failed`. Callers use it only if `shouldAutoRetry` returns `false`. */
export const fail = (_state: Running): Failed => new Failed();

export const retry = (_state: Failed): Running => new Running();

export const cancelByOperator = (_state: Open): Canceled =>
  new Canceled({ reason: new OperatorCanceled() });

/**
 * Returns `Canceled` for a Run replaced by the newer Event `by`. A running Run isn't
 * superseded; the engine evaluates the newer Event after its Attempt ends (ADR 0007).
 */
export const supersede = (_state: Unstarted, by: EventId): Canceled =>
  new Canceled({ reason: new Superseded({ by }) });

export const revoke = (_state: Unstarted): Canceled => new Canceled({ reason: new Revoked() });
