import { OperatorActor } from "../operator.ts";
import { Effect, Option, Schema } from "effect";
import { LoopName } from "../loop.ts";
import { CiHandoff } from "../ci.ts";
import { CommitSha } from "../repository.ts";
import { RunId } from "./id.ts";
import { EventId } from "../event.ts";

/** An operator-requested cancellation, with the operator login when recorded. */
export class OperatorCanceled extends Schema.TaggedClass<OperatorCanceled>(
  "CancelReason/OperatorCanceled",
)("OperatorCanceled", {
  /** The canceling operator's login, or `None` if none was recorded. */
  by: Schema.OptionFromNullOr(OperatorActor).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeedNone),
  ),
}) {}

/** Cancellation because a newer Event for the same Item arrived before any Attempt started. */
export class Superseded extends Schema.TaggedClass<Superseded>("CancelReason/Superseded")(
  "Superseded",
  {
    /** The newer event that replaced this unstarted run. */
    by: EventId,
  },
) {}

/** Cancellation because the Item stopped matching the Loop's trigger before any Attempt started. */
export class Revoked extends Schema.TaggedClass<Revoked>("CancelReason/Revoked")("Revoked", {}) {}

/** Cancellation because another push replaced a head awaiting CI. */
export class HeadChanged extends Schema.TaggedClass<HeadChanged>("CancelReason/HeadChanged")(
  "HeadChanged",
  { head: CommitSha },
) {}

/** Why a run was canceled: operator action, a newer event or head, or an item that stopped matching its trigger. */
export const CancelReason = Schema.Union([OperatorCanceled, Superseded, Revoked, HeadChanged]);
export type CancelReason = typeof CancelReason.Type;

/** A new Run with no Attempt started and no approval gate passed. */
export class Pending extends Schema.TaggedClass<Pending>("RunState/Pending")("Pending", {}) {}

/** A Run waiting for its Loop's approval Event. */
export class Waiting extends Schema.TaggedClass<Waiting>("RunState/Waiting")("Waiting", {}) {}

/** An approved Run waiting for a Worker slot. */
export class Queued extends Schema.TaggedClass<Queued>("RunState/Queued")("Queued", {}) {}

/** A Run with an Attempt running on a Worker. */
export class Running extends Schema.TaggedClass<Running>("RunState/Running")("Running", {}) {}

/** A run whose agent session ended and whose pushed head awaits CI. */
export class AwaitingCi extends Schema.TaggedClass<AwaitingCi>("RunState/AwaitingCi")(
  "AwaitingCi",
  { handoff: CiHandoff },
) {}

/** A Run whose Step finished with a stored result. */
export class Succeeded extends Schema.TaggedClass<Succeeded>("RunState/Succeeded")(
  "Succeeded",
  {},
) {}

/** A closed run whose failed CI continues in an admitted fix run. */
export class HandedOff extends Schema.TaggedClass<HandedOff>("RunState/HandedOff")("HandedOff", {
  reason: Schema.NonEmptyString,
  head: CommitSha,
  fixLoop: LoopName,
  fixRunId: RunId,
}) {}

/** A Run whose last Attempt failed without an auto-retry; the failure is stored on the Attempt. */
export class Failed extends Schema.TaggedClass<Failed>("RunState/Failed")("Failed", {}) {}

/** A closed run with the reason no further attempt should start. */
export class Canceled extends Schema.TaggedClass<Canceled>("RunState/Canceled")("Canceled", {
  /** The operator action or trigger change that closed the run. */
  reason: CancelReason,
}) {}

/** The states of a Run that isn't closed. */
export const Open = Schema.Union([Pending, Waiting, Queued, Running, AwaitingCi]);
export type Open = typeof Open.Type;

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
 *   running ──► awaiting CI ──► succeeded / handed off / failed / canceled (ADR 0033)
 *
 * Each transition accepts only its legal source states, so an illegal transition is a type
 * error. States come from the transitions or from decoding a stored row with `RunState`.
 */
export const RunState = Schema.Union([...Open.members, Succeeded, HandedOff, Failed, Canceled]);
export type RunState = typeof RunState.Type;

/** The states before any Attempt starts, accepted by `supersede` and `revoke`. */
export const Unstarted = Schema.Union([Pending, Waiting, Queued]);
export type Unstarted = typeof Unstarted.Type;

/** The states from which an Attempt can start. */
export const Startable = Schema.Union([Pending, Queued]);
export type Startable = typeof Startable.Type;

/** Returns whether a run is open, including a CI wait. */
export const isOpen = Schema.is(Open);
/** Returns whether a value is a state with no started attempt, which permits supersede or revoke. */
export const isUnstarted = Schema.is(Unstarted);
/** Returns whether a value is a pending or queued state from which an attempt can start. */
export const isStartable = Schema.is(Startable);

/** Returns the operator actions allowed in `state`. */
export const operatorActions = (state: RunState) => ({
  /** Whether the run is waiting for approval. */
  canApprove: state._tag === "Waiting",
  /** Whether the failed run permits an operator retry. */
  canRetry: state._tag === "Failed",
  /** Whether the run is failed; callers also check whether its latest failure is already resolved. */
  canResolveFailure: state._tag === "Failed",
  /** Whether the run is open and permits operator cancellation. */
  canCancel: isOpen(state),
  /** Whether the run succeeded or was canceled, permitting a new run for the same item state. */
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
export const OPEN_STATE_TAGS = tagsOf<Open>()(
  "Pending",
  "Waiting",
  "Queued",
  "Running",
  "AwaitingCi",
);

/** The `_tag` values of `RunState`. */
export const STATE_TAGS = tagsOf<RunState>()(
  "Pending",
  "Waiting",
  "Queued",
  "Running",
  "AwaitingCi",
  "Succeeded",
  "HandedOff",
  "Failed",
  "Canceled",
);

/** The `_tag` values of `Unstarted`, for SQL filters. */
export const UNSTARTED_STATE_TAGS = tagsOf<Unstarted>()("Pending", "Waiting", "Queued");

/** Returns the waiting state for a pending run whose loop requires approval. */
export const awaitApproval = (_state: Pending): Waiting => Waiting.make();

/** Returns the queued state for a waiting run after approval, ready for a worker slot. */
export const approve = (_state: Waiting): Queued => Queued.make();

/** Returns the running state for a pending or queued run when its attempt starts. */
export const start = (_state: Startable): Running => Running.make();

/** Returns the succeeded state for a running run after its step result is stored. */
export const succeed = (_state: Running): Succeeded => Succeeded.make();

/** Returns `Failed`. Callers use it only if `shouldAutoRetry` returns `false`. */
export const fail = (_state: Running): Failed => Failed.make();

/** Returns the running state for a failed run when an operator starts another attempt. */
export const retry = (_state: Failed): Running => Running.make();

/** Returns a canceled state for an open run, recording `by` when an operator login is available. Does not stop the running attempt itself. */
export const cancelByOperator = (
  _state: Open,
  by: Option.Option<OperatorActor> = Option.none(),
): Canceled => Canceled.make({ reason: OperatorCanceled.make({ by }) });

/**
 * Returns `Canceled` for a Run replaced by the newer Event `by`. A running Run isn't
 * superseded; the engine evaluates the newer Event after its Attempt ends (ADR 0007).
 */
export const supersede = (_state: Unstarted, by: EventId): Canceled =>
  Canceled.make({ reason: Superseded.make({ by }) });

/** Returns a canceled state for an unstarted run whose item no longer matches its loop's trigger (ADR 0007). */
export const revoke = (_state: Unstarted): Canceled => Canceled.make({ reason: Revoked.make() });
