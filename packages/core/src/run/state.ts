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
 * Each transition accepts only the states it is legal on, so an illegal
 * transition fails to compile. Construct states through the transitions or by
 * decoding a stored row with `RunState`.
 */

/** The operator closed the run by hand. */
export class OperatorCanceled extends Schema.TaggedClass<OperatorCanceled>(
  "CancelReason/OperatorCanceled",
)("OperatorCanceled", {}) {}

/** A newer Event for the same Item took the run's place before any attempt started. */
export class Superseded extends Schema.TaggedClass<Superseded>("CancelReason/Superseded")(
  "Superseded",
  { by: EventId },
) {}

/** The run's Item stopped matching its loop's trigger before any attempt started. */
export class Revoked extends Schema.TaggedClass<Revoked>("CancelReason/Revoked")("Revoked", {}) {}

export const CancelReason = Schema.Union([OperatorCanceled, Superseded, Revoked]);
export type CancelReason = typeof CancelReason.Type;

/** Just created: no attempt started and no approval gate passed. */
export class Pending extends Schema.TaggedClass<Pending>("RunState/Pending")("Pending", {}) {}

/** Parked on the loop's approval gate. The approval it waits for is an Event like any other fact. */
export class Waiting extends Schema.TaggedClass<Waiting>("RunState/Waiting")("Waiting", {}) {}

/** Approved and waiting for a worker slot. */
export class Queued extends Schema.TaggedClass<Queued>("RunState/Queued")("Queued", {}) {}

/** An attempt is executing on a worker. */
export class Running extends Schema.TaggedClass<Running>("RunState/Running")("Running", {}) {}

/** The step finished and its result is stored. */
export class Succeeded extends Schema.TaggedClass<Succeeded>("RunState/Succeeded")(
  "Succeeded",
  {},
) {}

/** The last attempt failed and no auto-retry applies. The failure is on the Attempt, and `retry` reopens the run. */
export class Failed extends Schema.TaggedClass<Failed>("RunState/Failed")("Failed", {}) {}

/** Canceled, with the reason recorded. */
export class Canceled extends Schema.TaggedClass<Canceled>("RunState/Canceled")("Canceled", {
  reason: CancelReason,
}) {}

/** Runs that still owe work, including those waiting for approval or a Worker. */
export const Open = Schema.Union([Pending, Waiting, Queued, Running]);
export type Open = typeof Open.Type;

/** A Run's progress from creation through approval and execution to a recorded outcome. */
export const RunState = Schema.Union([...Open.members, Succeeded, Failed, Canceled]);
export type RunState = typeof RunState.Type;

/** The states with no attempt started: what `supersede` and `revoke` accept. */
export const Unstarted = Schema.Union([Pending, Waiting, Queued]);
export type Unstarted = typeof Unstarted.Type;

/** The states an attempt can start from: the gate is passed or absent. */
export const Startable = Schema.Union([Pending, Queued]);
export type Startable = typeof Startable.Type;

export const isOpen = Schema.is(Open);
export const isUnstarted = Schema.is(Unstarted);
export const isStartable = Schema.is(Startable);

/**
 * The operator actions permitted by a Run's lifecycle state. Command handlers still apply the typed transitions.
 * `canRunAgain` holds for a Run that succeeded or was canceled: running it again opens a new Run
 * for the same Item state, while a failed Run is retried instead (ADR 0002).
 */
export const operatorActions = (state: RunState) => ({
  canApprove: state._tag === "Waiting",
  canRetry: state._tag === "Failed",
  canResolveFailure: state._tag === "Failed",
  canCancel: isOpen(state),
  canRunAgain: state._tag === "Succeeded" || state._tag === "Canceled",
});

/**
 * Builds a tag tuple that must name every `_tag` of `State` and nothing else,
 * so the SQL-side lists below cannot drift from the unions above. A foreign tag
 * fails the `Tags` constraint; a missing tag collapses the parameters to `[never]`.
 */
const tagsOf =
  <State extends RunState>() =>
  <const Tags extends ReadonlyArray<State["_tag"]>>(
    ...tags: [State["_tag"]] extends [Tags[number]] ? Tags : [never]
  ) =>
    tags;

/** The open states as `_tag` literals, for queries that filter stored rows. */
export const OPEN_STATE_TAGS = tagsOf<Open>()("Pending", "Waiting", "Queued", "Running");

/** Every state as a `_tag` literal, for read models that project stored rows. */
export const STATE_TAGS = tagsOf<RunState>()(
  "Pending",
  "Waiting",
  "Queued",
  "Running",
  "Succeeded",
  "Failed",
  "Canceled",
);

/** The unstarted states as `_tag` literals, for queries that filter stored rows. */
export const UNSTARTED_STATE_TAGS = tagsOf<Unstarted>()("Pending", "Waiting", "Queued");

/** Moves a pending Run to the waiting state until its Loop's required approval arrives. */
export const awaitApproval = (_state: Pending): Waiting => new Waiting();

/** Returns the approved state; the Run still waits for a Worker slot before execution. */
export const approve = (_state: Waiting): Queued => new Queued();

/** Returns the running state for a first Attempt after any required approval has been granted. */
export const start = (_state: Startable): Running => new Running();

/** Closes the run after a successful attempt. */
export const succeed = (_state: Running): Succeeded => new Succeeded();

/** Closes the run after a failed attempt when no auto-retry applies; `shouldAutoRetry` decides that. */
export const fail = (_state: Running): Failed => new Failed();

/** Returns the reopened state for operator retry; attempt N+1 belongs to the same Run and Step. */
export const retry = (_state: Failed): Running => new Running();

/** Cancels from any open state. */
export const cancelByOperator = (_state: Open): Canceled =>
  new Canceled({ reason: new OperatorCanceled() });

/**
 * Cancels an unstarted run because a newer Event for the same Item replaced it.
 * A running Attempt always finishes, and the engine evaluates the newer Event after it ends (ADR 0007).
 */
export const supersede = (_state: Unstarted, by: EventId): Canceled =>
  new Canceled({ reason: new Superseded({ by }) });

/** Cancels an unstarted run because its Item stopped matching the loop's trigger. */
export const revoke = (_state: Unstarted): Canceled => new Canceled({ reason: new Revoked() });
