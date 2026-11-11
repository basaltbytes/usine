import * as AttemptChannel from "@usine/core/attempt/channel";
import { Effect, Equal, Match, Option } from "effect";

import type { StoredRequest } from "../attempt-runtime.ts";

import {
  type CoordinationStatus,
  CoordinatorSnapshot,
  type EncodedDecision,
  type EventSequence,
  JournalRevision,
  LedgerEntry,
  Open,
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
        delegations.push(intent.delegation);
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
  });
