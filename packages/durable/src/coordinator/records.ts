import { AttemptId } from "@usine/core/attempt";
import { type Brand, Effect, Schema } from "effect";

import { CoordinatorEvent, CoordinatorState } from "../attempt/coordinator/rules.ts";
import { EncodedDecision, EncodedEvent, EncodedState } from "./journal.ts";
import { RecordedDecision } from "./wake-up.ts";

/** A record that the coordinator stores encoded in the attempt journal. */
const StoredRecord = Schema.Literals(["state", "decision", "delegation outcome"]);
type StoredRecord = typeof StoredRecord.Type;

/** A stored record that no longer decodes, as after an upgrade changed its shape. */
export class UnreadableRecord extends Schema.TaggedError<
  UnreadableRecord,
  Brand.Brand<"@usine/durable/coordinator/records/UnreadableRecord">
>("@usine/durable/UnreadableRecord")("UnreadableRecord", {
  attemptId: AttemptId,
  record: StoredRecord,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    const cause = this.cause instanceof Error ? this.cause.message : String(this.cause);
    return `The stored ${this.record} of Attempt ${this.attemptId} no longer decodes: ${cause}`;
  }
}

const EventCodec = Schema.toCodecJson(CoordinatorEvent);
const StateCodec = Schema.toCodecJson(CoordinatorState);
const DecisionCodec = Schema.toCodecJson(RecordedDecision);

const unreadable = (attemptId: AttemptId, record: StoredRecord) =>
  Effect.mapError((cause: Schema.SchemaError) =>
    UnreadableRecord.make({ attemptId, record, cause }),
  );

// The coordinator built every value it encodes, so an encoding failure is a defect.

/** Encodes `event` for the journal. */
export const encodeEvent = (event: CoordinatorEvent) =>
  Schema.encodeEffect(EventCodec)(event).pipe(Effect.orDie, Effect.map(EncodedEvent.make));

/** Encodes `state` for the journal. */
export const encodeState = (state: CoordinatorState) =>
  Schema.encodeEffect(StateCodec)(state).pipe(Effect.orDie, Effect.map(EncodedState.make));

/** Encodes `decision` for the journal. */
export const encodeDecision = (decision: RecordedDecision) =>
  Schema.encodeEffect(DecisionCodec)(decision).pipe(Effect.orDie, Effect.map(EncodedDecision.make));

/** Decodes the event that ended a delegation of Attempt `attemptId`. */
export const decodeOutcome = (attemptId: AttemptId, encoded: EncodedEvent) =>
  Schema.decodeEffect(EventCodec)(encoded).pipe(unreadable(attemptId, "delegation outcome"));

/** Decodes the coordinator state of Attempt `attemptId`. */
export const decodeState = (attemptId: AttemptId, encoded: EncodedState) =>
  Schema.decodeEffect(StateCodec)(encoded).pipe(unreadable(attemptId, "state"));

/** Decodes a decision recorded for an event of Attempt `attemptId`. */
export const decodeDecision = (attemptId: AttemptId, encoded: EncodedDecision) =>
  Schema.decodeEffect(DecisionCodec)(encoded).pipe(unreadable(attemptId, "decision"));
