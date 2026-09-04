/**
 * The run state machine (ADR 0002):
 *
 *   pending ─────────────────────────► running ──► succeeded
 *      │                               ▲  │
 *      ▼                               │  ▼
 *   waiting ──(approval)──► queued ────┘ failed ──► (retry: attempt N+1) ──► running
 *
 *   pending | waiting | queued | running ──► canceled   (operator cancel)
 *   pending | waiting | queued           ──► canceled   (supersede, revoke — a started
 *                                                        attempt always finishes, ADR 0007)
 *
 * States are value objects (a discriminated union, each state carrying exactly
 * its own data). Transitions are typestate derivers: each function accepts
 * only the states it is legal on, so an illegal transition is a compile
 * error. Construct states through these transitions (or by parsing a stored
 * row via the `RunState` union) — they are the state machine.
 */
import { Schema } from "effect";
import { EventId } from "../ids.ts";

/** Cancel reason — value object: the operator closed the run by hand. */
export class OperatorCanceled extends Schema.TaggedClass<OperatorCanceled>(
  "CancelReason/OperatorCanceled",
)("OperatorCanceled", {}) {}

/**
 * Cancel reason — value object: a newer Event for the same Item took the
 * run's place before any attempt started.
 */
export class Superseded extends Schema.TaggedClass<Superseded>("CancelReason/Superseded")(
  "Superseded",
  { by: EventId },
) {}

/**
 * Cancel reason — value object: the run's Item stopped matching its loop's
 * trigger before any attempt started. Distinct from operator cancel and from
 * supersede.
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

/** Open: the approval gate opened; no attempt started. Waits for a worker slot like Pending. */
export class Queued extends Schema.TaggedClass<Queued>("RunState/Queued")("Queued", {}) {}

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

/**
 * The open half of the machine — the single statement of the open/closed
 * partition; the alias, the guard, and the full union all derive from it.
 */
export const Open = Schema.Union([Pending, Waiting, Queued, Running]);
export type Open = typeof Open.Type;

export const RunState = Schema.Union([...Open.members, Succeeded, Failed, Canceled]);
export type RunState = typeof RunState.Type;

/** No attempt started yet: the precondition of `supersede` and `revoke`. */
export const Unstarted = Schema.Union([Pending, Waiting, Queued]);
export type Unstarted = typeof Unstarted.Type;

/** Gate passed or absent: the states an attempt can start from. */
export const Startable = Schema.Union([Pending, Queued]);
export type Startable = typeof Startable.Type;

export const isOpen = Schema.is(Open);
export const isUnstarted = Schema.is(Unstarted);
export const isStartable = Schema.is(Startable);

/**
 * Compile-checked tag tuple over a state partition: the argument list must
 * name every `_tag` of `State` and nothing else. A foreign tag fails the
 * `Tags` constraint; a missing tag collapses the parameters to `[never]`, so
 * the call stops compiling. This keeps the unions above the single owner of
 * each partition while read-side SQL gets a value-level tag list.
 */
const tagsOf =
  <State extends RunState>() =>
  <const Tags extends ReadonlyArray<State["_tag"]>>(
    ...tags: [State["_tag"]] extends [Tags[number]] ? Tags : [never]
  ) =>
    tags;

/** The open partition as `_tag` literals, for queries that filter stored rows by state. */
export const OPEN_STATE_TAGS = tagsOf<Open>()("Pending", "Waiting", "Queued", "Running");

/** Every state as `_tag` literals, for read models that project stored rows by state. */
export const STATE_TAGS = tagsOf<RunState>()(
  "Pending",
  "Waiting",
  "Queued",
  "Running",
  "Succeeded",
  "Failed",
  "Canceled",
);

/**
 * The states with no started attempt, as `_tag` literals — the precondition
 * of `supersede` and `revoke`, for queries that filter stored rows by state.
 */
export const UNSTARTED_STATE_TAGS = tagsOf<Unstarted>()("Pending", "Waiting", "Queued");

/** pending → waiting: park the run on its loop's approval gate. */
export const awaitApproval = (_state: Pending): Waiting => new Waiting();

/** waiting → queued: the approval Event opened the gate; the run now waits for a worker slot. */
export const approve = (_state: Waiting): Queued => new Queued();

/** pending | queued → running: the first attempt starts. A waiting run must be approved first. */
export const start = (_state: Startable): Running => new Running();

/** running → succeeded: the attempt finished and the step result is stored. */
export const succeed = (_state: Running): Succeeded => new Succeeded();

/**
 * running → failed: the attempt failed and no auto-retry applies — the engine
 * discharges that precondition with `Attempt.shouldAutoRetry`, the one owner
 * of the auto-retry law.
 */
export const fail = (_state: Running): Failed => new Failed();

/**
 * failed → running: operator retry. The next try is a new Attempt (N+1) under
 * the same Step, never a new run.
 */
export const retry = (_state: Failed): Running => new Running();

/**
 * open → canceled: the operator's act, reachable from every open state —
 * named by cause like its siblings; supersede and revoke are the other two
 * roads into Canceled.
 */
export const cancelByOperator = (_state: Open): Canceled =>
  new Canceled({ reason: new OperatorCanceled() });

/**
 * pending | waiting | queued → canceled: a newer Event for the same Item takes
 * this run's place. Only runs with no started attempt can be superseded — a
 * running attempt always finishes, and the newer state is judged again when it
 * ends (ADR 0007).
 */
export const supersede = (_state: Unstarted, by: EventId): Canceled =>
  new Canceled({ reason: new Superseded({ by }) });

/**
 * pending | waiting | queued → canceled: the run's Item stopped matching its
 * loop's trigger. Never touches a running attempt.
 */
export const revoke = (_state: Unstarted): Canceled => new Canceled({ reason: new Revoked() });
