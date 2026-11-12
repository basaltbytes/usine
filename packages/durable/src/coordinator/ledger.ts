import type { ChildSessionCount } from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { Duration, Effect, Equal, Match, Option, Schema } from "effect";

import type { StoredRequest } from "../attempt-runtime.ts";

import {
  ChildProgress,
  type QueuedInput,
  type Supervision,
  type CoordinationStatus,
  CoordinatorSnapshot,
  DelegationRecord,
  DelegationStarted,
  type EncodedDecision,
  type EncodedEvent,
  type EventSequence,
  JournalRevision,
  LedgerEntry,
  Open,
  type ProgressChange,
  Settled,
  StaleRevision,
  Terminal,
  type Transition,
} from "./journal.ts";

// The invariants every adapter enforces. A breach is a coordinator defect, so it dies.

const invariant = (message: string) => Effect.die(new Error(message));

/** Returns the snapshot with `envelopes` appended to the outbox. */
export const reserved = (
  snapshot: CoordinatorSnapshot,
  envelopes: ReadonlyArray<AttemptChannel.OutboundEnvelope>,
) =>
  Effect.gen(function* () {
    for (const [index, envelope] of envelopes.entries()) {
      if (envelope.attemptId !== snapshot.attemptId)
        return yield* invariant(
          `Envelope for Attempt ${envelope.attemptId} reserved in Attempt ${snapshot.attemptId}`,
        );
      if (envelope.sequence !== snapshot.nextOutbound + index)
        return yield* invariant(
          `Envelope ${envelope.sequence} reserved where ${snapshot.nextOutbound + index} is next`,
        );
    }
    return CoordinatorSnapshot.make({
      ...snapshot,
      outbox: [...snapshot.outbox, ...envelopes],
      nextOutbound: AttemptChannel.Sequence.make(snapshot.nextOutbound + envelopes.length),
    });
  });

/** Returns the snapshot without the envelopes up to and including `through`. */
export const acknowledged = (snapshot: CoordinatorSnapshot, through: AttemptChannel.Sequence) =>
  CoordinatorSnapshot.make({
    ...snapshot,
    outbox: snapshot.outbox.filter(({ sequence }) => sequence > through),
  });

/**
 * Returns the decision recorded for event `sequence`, and the snapshot with `decision` recorded if
 * none was.
 */
export const decided = (
  snapshot: CoordinatorSnapshot,
  sequence: EventSequence,
  decision: EncodedDecision,
) =>
  Effect.gen(function* () {
    if (sequence > snapshot.nextEvent)
      return yield* invariant(
        `Decision for event ${sequence} recorded where ${snapshot.nextEvent} is next`,
      );
    const applied = snapshot.events[sequence - 1];
    if (applied !== undefined) return { recorded: applied.decision, snapshot };
    return Option.match(snapshot.pendingDecision, {
      onSome: (recorded) => ({ recorded, snapshot }),
      onNone: () => ({
        recorded: decision,
        snapshot: CoordinatorSnapshot.make({ ...snapshot, pendingDecision: Option.some(decision) }),
      }),
    });
  });

/** Logs why `decide` kept the recorded decision instead of `discarded`. */
export const keptDecision = (
  snapshot: CoordinatorSnapshot,
  sequence: EventSequence,
  recorded: EncodedDecision,
  discarded: EncodedDecision,
) =>
  Equal.equals(recorded, discarded)
    ? Effect.logInfo("Kept the decision recorded first; the new decision matches it", {
        attemptId: snapshot.attemptId,
        sequence,
      })
    : Effect.logInfo("Kept the decision recorded first; discarded a different decision", {
        attemptId: snapshot.attemptId,
        sequence,
      });

/** Returns the snapshot after `step`, or fails if `expected` is stale. */
export const transitioned = (
  snapshot: CoordinatorSnapshot,
  expected: JournalRevision,
  step: Transition,
) =>
  Effect.gen(function* () {
    if (snapshot.revision !== expected)
      return yield* StaleRevision.make({
        attemptId: snapshot.attemptId,
        expected,
        actual: snapshot.revision,
      });
    if (snapshot.status._tag !== "Open")
      return yield* invariant(`Transition after Attempt ${snapshot.attemptId} finished`);
    if (Option.isSome(snapshot.pendingDecision)) {
      if (!Equal.equals(snapshot.pendingDecision.value, step.decision))
        return yield* invariant(
          `Transition for event ${snapshot.nextEvent} applies a decision other than the recorded one`,
        );
    }
    const delegations = [...snapshot.delegations];
    let status: CoordinationStatus = snapshot.status;
    for (const intent of step.intents) {
      if (intent._tag === "Delegate") {
        if (delegations.some(({ number }) => number === intent.delegation.number))
          return yield* invariant(
            `Transition for event ${snapshot.nextEvent} repeats delegation ${intent.delegation.number}`,
          );
        delegations.push(
          DelegationRecord.make({
            ...intent.delegation,
            progress: Option.none(),
            outcome: Option.none(),
          }),
        );
      } else {
        if (status._tag !== "Open")
          return yield* invariant(
            `Transition for event ${snapshot.nextEvent} finishes the Attempt twice`,
          );
        status = Terminal.make({ outcome: intent.outcome });
      }
    }
    delegations.sort((left, right) => left.number - right.number);
    const appended = CoordinatorSnapshot.make({
      ...snapshot,
      revision: JournalRevision.make(snapshot.revision + 1),
      state: Option.some(step.state),
      status,
      events: [
        ...snapshot.events,
        LedgerEntry.make({
          sequence: snapshot.nextEvent,
          event: step.event,
          decision: step.decision,
        }),
      ],
      pendingDecision: Option.none(),
      delegations,
    });
    return yield* reserved(appended, step.outbound);
  });

/** Returns the settled snapshot, or `None` if it was already settled. */
export const settled = (snapshot: CoordinatorSnapshot) =>
  Match.valueTags(snapshot.status, {
    Settled: () => Option.none<Settled>(),
    Open: () => Option.some(Settled.make({ outcome: Option.none() })),
    Terminal: ({ outcome }) => Option.some(Settled.make({ outcome: Option.some(outcome) })),
  }).pipe(
    Option.map((status) =>
      CoordinatorSnapshot.make({
        ...snapshot,
        status,
        revision: JournalRevision.make(snapshot.revision + 1),
      }),
    ),
  );

/** The snapshot of an Attempt just opened. */
export const opened = (request: StoredRequest) =>
  CoordinatorSnapshot.make({
    request,
    revision: JournalRevision.make(0),
    state: Option.none(),
    status: Open.make({}),
    events: [],
    pendingDecision: Option.none(),
    delegations: [],
    outbox: [],
    nextOutbound: AttemptChannel.Sequence.make(1),
    result: Option.none(),
    unsupervised: Option.none(),
    supervision: [],
    inputs: [],
    nextInbound: AttemptChannel.Sequence.make(1),
  });

/** Returns delegation `number`, or dies if no transition decided it. */
export const delegationOf = (
  snapshot: CoordinatorSnapshot,
  number: ChildSessionCount,
): Effect.Effect<DelegationRecord> =>
  Option.match(
    Option.fromUndefinedOr(snapshot.delegations.find((record) => record.number === number)),
    {
      onNone: () => invariant(`Attempt ${snapshot.attemptId} has no delegation ${number}`),
      onSome: Effect.succeed,
    },
  );

/** Returns the snapshot with `record` replacing the delegation of the same number. */
export const withDelegation = (snapshot: CoordinatorSnapshot, record: DelegationRecord) =>
  CoordinatorSnapshot.make({
    ...snapshot,
    delegations: snapshot.delegations.map((current) =>
      current.number === record.number ? record : current,
    ),
  });

/** Returns how a delegation starts, and the record with its start recorded if it hadn't started. */
export const startedDelegation = (record: DelegationRecord) =>
  Option.match(record.progress, {
    onSome: (progress) => ({
      started: DelegationStarted.make({ resumed: true, progress }),
      record,
    }),
    onNone: () => {
      const progress = ChildProgress.empty();
      return {
        started: DelegationStarted.make({ resumed: false, progress }),
        record: DelegationRecord.make({ ...record, progress: Option.some(progress) }),
      };
    },
  });

const decodeSavedObject = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json));

const changed = (progress: ChildProgress, change: ProgressChange): ChildProgress =>
  ChildProgress.make({
    ...progress,
    ...Match.valueTags(change, {
      SessionSaved: ({ saved, beforePrompt }) => ({
        saved: Option.some(saved),
        prompted: beforePrompt && Option.isNone(progress.saved) ? false : progress.prompted,
      }),
      Prompted: () => ({ prompted: true }),
      ContinuationsSaved: ({ timestamps }) => ({ continuations: timestamps }),
      UsageSaved: ({ usage }) => ({
        saved: Option.map(progress.saved, (saved) =>
          Option.match(decodeSavedObject(saved), {
            onNone: () => saved,
            onSome: (object) => ({ ...object, usage }),
          }),
        ),
      }),
      ToolStarted: ({ callId, tool }) => ({
        inFlight: [...progress.inFlight.filter((call) => call.callId !== callId), { callId, tool }],
      }),
      ToolFinished: ({ callId }) => ({
        inFlight: progress.inFlight.filter((call) => call.callId !== callId),
      }),
      IdleSaved: ({ report, answeredOperator }) => ({
        idle: report,
        idleAnsweredOperator: Option.isSome(report) && answeredOperator,
      }),
      OutputSaved: ({ output }) => ({ output }),
    }),
  });

/** Returns the record with `change` applied, or dies if the delegation hasn't started. */
export const progressed = (
  record: DelegationRecord,
  change: ProgressChange,
): Effect.Effect<DelegationRecord> =>
  Option.match(record.progress, {
    onNone: () => invariant(`Progress saved for delegation ${record.number}, which hasn't started`),
    onSome: (progress) =>
      Effect.succeed(
        DelegationRecord.make({ ...record, progress: Option.some(changed(progress, change)) }),
      ),
  });

/** Returns the outcome recorded for the delegation, and the record with `outcome` if it had none. */
export const settledDelegation = (record: DelegationRecord, outcome: EncodedEvent) =>
  Option.match(record.outcome, {
    onSome: (recorded) => ({ recorded, record }),
    onNone: () => ({
      recorded: outcome,
      record: DelegationRecord.make({ ...record, outcome: Option.some(outcome) }),
    }),
  });

const decodeTagged = Schema.decodeUnknownOption(Schema.Struct({ _tag: Schema.String }));

/** The `_tag` of an encoded event, or `unknown` if it has none. */
const eventTag = (event: EncodedEvent) =>
  Option.match(decodeTagged(event), { onNone: () => "unknown", onSome: ({ _tag }) => _tag });

/** Logs why `settleDelegation` kept the outcome recorded first instead of `discarded`. */
export const keptDelegationOutcome = (
  attemptId: CoordinatorSnapshot["attemptId"],
  delegation: DelegationRecord["number"],
  recorded: EncodedEvent,
  discarded: EncodedEvent,
) =>
  Equal.equals(recorded, discarded)
    ? Effect.logInfo("Kept the delegation outcome recorded first; the new outcome matches it", {
        attemptId,
        delegation,
        outcome: eventTag(recorded),
      })
    : Effect.logInfo("Kept the delegation outcome recorded first; discarded a different outcome", {
        attemptId,
        delegation,
        outcome: eventTag(recorded),
        discarded: eventTag(discarded),
      });

/** Returns the snapshot with the longer of its unsupervised time and `unsupervised`. */
export const unsupervisedRecorded = (
  snapshot: CoordinatorSnapshot,
  unsupervised: Duration.Duration,
) =>
  CoordinatorSnapshot.make({
    ...snapshot,
    unsupervised: Option.some(
      Option.match(snapshot.unsupervised, {
        onNone: () => unsupervised,
        onSome: (kept) => Duration.max(kept, unsupervised),
      }),
    ),
  });

/** Returns the snapshot with `supervision` replacing the session's stored supervision. */
export const supervised = (snapshot: CoordinatorSnapshot, supervision: Supervision) =>
  CoordinatorSnapshot.make({
    ...snapshot,
    supervision: [
      ...snapshot.supervision.filter(({ sessionId }) => sessionId !== supervision.sessionId),
      ...(supervision.held || supervision.paused ? [supervision] : []),
    ].sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
  });

/** Returns the snapshot with `input` replacing a queued input of the same sequence. */
export const inputQueued = (snapshot: CoordinatorSnapshot, input: QueuedInput) =>
  CoordinatorSnapshot.make({
    ...snapshot,
    inputs: [
      ...snapshot.inputs.filter(({ inputSequence }) => inputSequence !== input.inputSequence),
      input,
    ].sort((left, right) => left.inputSequence - right.inputSequence),
  });

/** Returns whether input `inputSequence` was queued, and the snapshot without it. */
export const inputForgotten = (
  snapshot: CoordinatorSnapshot,
  inputSequence: AttemptChannel.Sequence,
) => {
  const inputs = snapshot.inputs.filter((input) => input.inputSequence !== inputSequence);
  return {
    forgotten: inputs.length < snapshot.inputs.length,
    snapshot: CoordinatorSnapshot.make({ ...snapshot, inputs }),
  };
};

/** Returns the snapshot whose next inbound sequence follows `sequence`, unless it is later. */
export const inboundRecorded = (snapshot: CoordinatorSnapshot, sequence: AttemptChannel.Sequence) =>
  CoordinatorSnapshot.make({
    ...snapshot,
    nextInbound: AttemptChannel.Sequence.make(Math.max(snapshot.nextInbound, sequence + 1)),
  });
