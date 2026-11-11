import { ChildSessionCount } from "@usine/core/agent/session";
import { AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AttemptFailure } from "@usine/core/attempt/failure";
import { type Brand, Context, type Effect, type Option, Schema } from "effect";

import { AttemptReport, StoredRequest } from "../attempt-runtime.ts";

/** The number of transitions applied to an Attempt's journal, plus one if it was settled. */
export const JournalRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand("JournalRevision"),
);
export type JournalRevision = typeof JournalRevision.Type;

/** The position of an event in an Attempt's ledger, starting at 1. */
export const EventSequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("EventSequence"),
);
export type EventSequence = typeof EventSequence.Type;

/** A coordinator event, encoded by the coordinator; the journal stores it unread. */
export const EncodedEvent = Schema.Json.pipe(Schema.brand("EncodedEvent"));
export type EncodedEvent = typeof EncodedEvent.Type;

/** A decision for one event, encoded by the coordinator; the journal stores it unread. */
export const EncodedDecision = Schema.Json.pipe(Schema.brand("EncodedDecision"));
export type EncodedDecision = typeof EncodedDecision.Type;

/** The coordinator's state after a transition, encoded by the coordinator. */
export const EncodedState = Schema.Json.pipe(Schema.brand("EncodedState"));
export type EncodedState = typeof EncodedState.Type;

/** An applied ledger entry: the event and the decision that handled it. */
export class LedgerEntry extends Schema.Class<
  LedgerEntry,
  Brand.Brand<"@usine/durable/coordinator/journal/LedgerEntry">
>("@usine/durable/LedgerEntry")({
  sequence: EventSequence,
  event: EncodedEvent,
  decision: EncodedDecision,
}) {}

/** A child the coordinator intends to run, recorded by the transition that decided it. */
export class Delegation extends Schema.Class<
  Delegation,
  Brand.Brand<"@usine/durable/coordinator/journal/Delegation">
>("@usine/durable/Delegation")({
  /** The child's slot in the Attempt's child-session budget. */
  number: ChildSessionCount,
  /** The supplemental instruction sent with the rendered task, or `None` for the task alone. */
  assignment: Schema.Option(Schema.NonEmptyString),
}) {}

export class Reported extends Schema.TaggedClass<
  Reported,
  Brand.Brand<"@usine/durable/coordinator/journal/Reported">
>("@usine/durable/coordinator/Reported")("Reported", {
  report: AttemptReport,
}) {}

export class Failed extends Schema.TaggedClass<
  Failed,
  Brand.Brand<"@usine/durable/coordinator/journal/Failed">
>("@usine/durable/coordinator/Failed")("Failed", {
  failure: AttemptFailure,
}) {}

/** The terminal outcome of a coordinated Attempt. */
export const CoordinatorOutcome = Schema.Union([Reported, Failed]);
export type CoordinatorOutcome = typeof CoordinatorOutcome.Type;

/** An Attempt that accepts transitions. */
export class Open extends Schema.TaggedClass<
  Open,
  Brand.Brand<"@usine/durable/coordinator/journal/Open">
>("@usine/durable/coordinator/Open")("Open", {}) {}

/** An Attempt whose transition recorded its outcome. */
export class Terminal extends Schema.TaggedClass<
  Terminal,
  Brand.Brand<"@usine/durable/coordinator/journal/Terminal">
>("@usine/durable/coordinator/Terminal")("Terminal", {
  outcome: CoordinatorOutcome,
}) {}

/** An Attempt that its caller stopped relaying, with the outcome it had reached, if any. */
export class Settled extends Schema.TaggedClass<
  Settled,
  Brand.Brand<"@usine/durable/coordinator/journal/Settled">
>("@usine/durable/coordinator/Settled")("Settled", {
  outcome: Schema.Option(CoordinatorOutcome),
}) {}

export const CoordinationStatus = Schema.Union([Open, Terminal, Settled]);
export type CoordinationStatus = typeof CoordinationStatus.Type;

/** Records a new child for the coordinator to launch after the commit. */
export class Delegate extends Schema.TaggedClass<
  Delegate,
  Brand.Brand<"@usine/durable/coordinator/journal/Delegate">
>("@usine/durable/coordinator/Delegate")("Delegate", {
  delegation: Delegation,
}) {}

/** Ends the Attempt with `outcome`; the Attempt accepts no transition afterward. */
export class Finish extends Schema.TaggedClass<
  Finish,
  Brand.Brand<"@usine/durable/coordinator/journal/Finish">
>("@usine/durable/coordinator/Finish")("Finish", {
  outcome: CoordinatorOutcome,
}) {}

/** An effect that a transition commits and the coordinator performs after the commit. */
export const Intent = Schema.Union([Delegate, Finish]);
export type Intent = typeof Intent.Type;

/** One handled event: everything `AttemptJournal.transition` commits together. */
export class Transition extends Schema.Class<
  Transition,
  Brand.Brand<"@usine/durable/coordinator/journal/Transition">
>("@usine/durable/Transition")({
  event: EncodedEvent,
  /** Must equal a decision already recorded for the event by `decide`. */
  decision: EncodedDecision,
  state: EncodedState,
  intents: Schema.Array(Intent),
  /**
   * Envelopes to reserve in the outbox. Their sequences continue the snapshot's `nextOutbound`.
   */
  outbound: Schema.Array(AttemptChannel.OutboundEnvelope),
}) {}

/** Everything the journal holds for one Attempt. */
export class CoordinatorSnapshot extends Schema.Class<
  CoordinatorSnapshot,
  Brand.Brand<"@usine/durable/coordinator/journal/CoordinatorSnapshot">
>("@usine/durable/CoordinatorSnapshot")({
  request: StoredRequest,
  revision: JournalRevision,
  /** `None` until the first transition. */
  state: Schema.Option(EncodedState),
  status: CoordinationStatus,
  /** Applied events in sequence order. */
  events: Schema.Array(LedgerEntry),
  /** The decision recorded for the next event before its transition committed. */
  pendingDecision: Schema.Option(EncodedDecision),
  /** Delegations in number order. */
  delegations: Schema.Array(Delegation),
  /** Reserved envelopes not yet acknowledged, in sequence order. */
  outbox: Schema.Array(AttemptChannel.OutboundEnvelope),
  /** The sequence of the next envelope to reserve. */
  nextOutbound: AttemptChannel.Sequence,
}) {
  get attemptId(): AttemptId {
    return this.request.spec.attemptId;
  }

  /** The sequence that the next event and its decision take. */
  get nextEvent(): EventSequence {
    return EventSequence.make(this.events.length + 1);
  }
}

/** A storage failure, with the operation that failed. */
export class JournalError extends Schema.TaggedError<
  JournalError,
  Brand.Brand<"@usine/durable/coordinator/journal/JournalError">
>("@usine/durable/JournalError")("JournalError", {
  /** What failed, as a verb phrase such as "save the child's conversation". */
  operation: Schema.String,
  attemptId: AttemptId,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    const cause = this.cause instanceof Error ? this.cause.message : String(this.cause);
    return `Could not ${this.operation}: ${cause}`;
  }
}

/** A refused transition whose expected revision differs from the stored one. */
export class StaleRevision extends Schema.TaggedError<
  StaleRevision,
  Brand.Brand<"@usine/durable/coordinator/journal/StaleRevision">
>("@usine/durable/coordinator/StaleRevision")("StaleRevision", {
  attemptId: AttemptId,
  expected: JournalRevision,
  actual: JournalRevision,
}) {}

/**
 * The event-driven coordinator's durable record of each Attempt: its stored request, an
 * append-only ledger of events with their decisions, the coordinator state, the delegations it
 * decided, and an outbox of channel envelopes awaiting the sink.
 *
 * Calling an operation other than `open`, `load`, or `settle` for an Attempt that was never opened
 * is a defect, as is a transition that breaks the ledger's invariants.
 */
export class AttemptJournal extends Context.Service<
  AttemptJournal,
  {
    /** Creates the Attempt's journal, or returns the existing one unchanged. */
    readonly open: (request: StoredRequest) => Effect.Effect<CoordinatorSnapshot, JournalError>;
    readonly load: (
      attemptId: AttemptId,
    ) => Effect.Effect<Option.Option<CoordinatorSnapshot>, JournalError>;
    /**
     * Appends the next event with its decision, replaces the state, records the intents, and
     * reserves the envelopes in one transaction, then returns the snapshot at the next revision.
     * Fails with `StaleRevision` if `expected` isn't the stored revision, including after `settle`.
     */
    readonly transition: (
      attemptId: AttemptId,
      expected: JournalRevision,
      step: Transition,
    ) => Effect.Effect<CoordinatorSnapshot, JournalError | StaleRevision>;
    /**
     * Records the decision for event `sequence` unless one is recorded, and returns the recorded
     * one. `sequence` must not be past the snapshot's `nextEvent`.
     */
    readonly decide: (
      attemptId: AttemptId,
      sequence: EventSequence,
      decision: EncodedDecision,
    ) => Effect.Effect<EncodedDecision, JournalError>;
    /** Appends envelopes to the outbox. Their sequences continue the snapshot's `nextOutbound`. */
    readonly reserve: (
      attemptId: AttemptId,
      envelopes: ReadonlyArray<AttemptChannel.OutboundEnvelope>,
    ) => Effect.Effect<void, JournalError>;
    /** Removes reserved envelopes up to and including `through`. Idempotent. */
    readonly acknowledge: (
      attemptId: AttemptId,
      through: AttemptChannel.Sequence,
    ) => Effect.Effect<void, JournalError>;
    /**
     * Marks the Attempt settled, keeping its outcome and outbox, and advances the revision so no
     * later transition commits. Idempotent; does nothing for an Attempt that was never opened.
     */
    readonly settle: (attemptId: AttemptId) => Effect.Effect<void, JournalError>;
  }
>()("@usine/durable/coordinator/journal/AttemptJournal") {}
