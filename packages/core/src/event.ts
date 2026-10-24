import { Schema } from "effect";

/** The ID of an Event; duplicates are detected by `DedupKey`, not by ID. */
export const EventId = Schema.NonEmptyString.pipe(Schema.brand("EventId"));

export type EventId = typeof EventId.Type;

/** The idempotency key that the engine derives from the watched state, excluding timestamps (ADR 0002). */
export const DedupKey = Schema.NonEmptyString.pipe(Schema.brand("DedupKey"));

export type DedupKey = typeof DedupKey.Type;

/**
 * A trigger match or operator approval. A trigger payload is the snapshot used by selection
 * expressions and prompt interpolation, and retries reuse it.
 */
export class Event extends Schema.Class<Event>("Event")({
  id: EventId,
  dedupKey: DedupKey,
  payload: Schema.Json,
  receivedAt: Schema.DateTimeUtc,
}) {}
