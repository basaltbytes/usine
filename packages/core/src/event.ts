import { Schema } from "effect";

export const EventId = Schema.NonEmptyString.pipe(Schema.brand("EventId"));

export type EventId = typeof EventId.Type;

/**
 * Idempotency key the engine derives from watched state, timestamps excluded.
 * The same state is the same Event forever, so a loop file never sets it (ADR 0002).
 */
export const DedupKey = Schema.NonEmptyString.pipe(Schema.brand("DedupKey"));

export type DedupKey = typeof DedupKey.Type;

/**
 * One deduplicated fact the engine may react to: a trigger match or an operator
 * approval. The payload is the stream's slice in GitHub's own shapes, which
 * expressions and loop bodies read as is.
 */
export class Event extends Schema.Class<Event>("Event")({
  id: EventId,
  dedupKey: DedupKey,
  payload: Schema.Json,
  receivedAt: Schema.DateTimeUtc,
}) {}
