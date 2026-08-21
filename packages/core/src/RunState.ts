/**
 * The run state machine (ADR 0002):
 *
 *   pending ──────────────► running ──► succeeded
 *      │                    ▲  │
 *      ▼                    │  ▼
 *   waiting ────────────────┘ failed ──► (retry: attempt N+1) ──► running
 *
 *   pending | waiting | running ──► canceled   (operator cancel)
 *   pending | waiting           ──► canceled   (supersede, revoke — a started
 *                                               attempt always finishes, ADR 0007)
 *
 * Transitions are typestate: each function accepts only the states it is legal
 * on, so an illegal transition is a compile error. Construct states through
 * these transitions (or by parsing a stored row via the `RunState` union) —
 * they are the state machine.
 */
import { Schema } from "effect";
import { EventId } from "./Event.ts";

/** The operator closed the run by hand. */
export class OperatorCanceled extends Schema.TaggedClass<OperatorCanceled>(
  "CancelReason/OperatorCanceled",
)("OperatorCanceled", {}) {}

/**
 * A newer Event for the same Item took the run's place before any attempt
 * started.
 */
export class Superseded extends Schema.TaggedClass<Superseded>("CancelReason/Superseded")(
  "Superseded",
  { by: EventId },
) {}

/**
 * The run's Item stopped matching its loop's trigger before any attempt
 * started. Distinct from operator cancel and from supersede.
 */
export class Revoked extends Schema.TaggedClass<Revoked>("CancelReason/Revoked")("Revoked", {}) {}

export const CancelReason = Schema.Union([OperatorCanceled, Superseded, Revoked]);
export type CancelReason = typeof CancelReason.Type;

/** Open: just created; no attempt started, no approval gate passed. */
export class Pending extends Schema.TaggedClass<Pending>("RunState/Pending")("Pending", {}) {}

/**
 * Open: parked on its loop's approval gate — v1's only waiting reason. The
 * approval it consumes is an Event like every other fact.
 */
export class Waiting extends Schema.TaggedClass<Waiting>("RunState/Waiting")("Waiting", {}) {}

/** Open: an attempt is executing on a worker. */
export class Running extends Schema.TaggedClass<Running>("RunState/Running")("Running", {}) {}

/** Closed: the step finished and its result is stored. */
export class Succeeded extends Schema.TaggedClass<Succeeded>("RunState/Succeeded")(
  "Succeeded",
  {},
) {}

/**
 * Closed, but reopenable: the last attempt failed and no auto-retry applies.
 * The failure itself lives on the Attempt.
 */
export class Failed extends Schema.TaggedClass<Failed>("RunState/Failed")("Failed", {}) {}

/** Closed: canceled, with the reason recorded. */
export class Canceled extends Schema.TaggedClass<Canceled>("RunState/Canceled")("Canceled", {
  reason: CancelReason,
}) {}

export const RunState = Schema.Union([Pending, Waiting, Running, Succeeded, Failed, Canceled]);
export type RunState = typeof RunState.Type;

export type Open = Pending | Waiting | Running;
export type Closed = Succeeded | Failed | Canceled;

export const isOpen = (state: RunState): state is Open =>
  state._tag === "Pending" || state._tag === "Waiting" || state._tag === "Running";

/** pending → waiting: park the run on its loop's approval gate. */
export const awaitApproval = (_state: Pending): Waiting => new Waiting();

/**
 * pending | waiting → running: the first attempt starts. From waiting, the
 * engine consumes the approval Event that opens the gate.
 */
export const start = (_state: Pending | Waiting): Running => new Running();

/** running → succeeded: the attempt finished and the step result is stored. */
export const succeed = (_state: Running): Succeeded => new Succeeded();

/** running → failed: the attempt failed and no auto-retry applies. */
export const fail = (_state: Running): Failed => new Failed();

/**
 * failed → running: operator retry. The next try is a new Attempt (N+1) under
 * the same Step, never a new run.
 */
export const retry = (_state: Failed): Running => new Running();

/** open → canceled: the operator's act, reachable from every open state. */
export const cancel = (_state: Open): Canceled => new Canceled({ reason: new OperatorCanceled() });

/**
 * pending | waiting → canceled: a newer Event for the same Item takes this
 * run's place. Only runs with no started attempt can be superseded — a running
 * attempt always finishes, and the newer state is judged again when it ends
 * (ADR 0007).
 */
export const supersede = (_state: Pending | Waiting, by: EventId): Canceled =>
  new Canceled({ reason: new Superseded({ by }) });

/**
 * pending | waiting → canceled: the run's Item stopped matching its loop's
 * trigger. Never touches a running attempt.
 */
export const revoke = (_state: Pending | Waiting): Canceled =>
  new Canceled({ reason: new Revoked() });
