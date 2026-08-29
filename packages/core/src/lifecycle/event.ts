import { Schema } from "effect";

/**
 * Value object (branded id): identity of one Event in the ledger.
 */
export const EventId = Schema.NonEmptyString.pipe(Schema.brand("EventId"));
export type EventId = typeof EventId.Type;

/**
 * Value object: the engine-derived, never-expiring idempotency key — timestamps aside, the
 * same watched state is the same Event, forever. Derived per trigger type,
 * never authored in a loop file (ADR 0002).
 */
export const DedupKey = Schema.NonEmptyString.pipe(Schema.brand("DedupKey"));
export type DedupKey = typeof DedupKey.Type;

/**
 * Entity — ledger row: one deduplicated fact the engine may react to — a trigger matching watched
 * state, or an operator approval. An Event owns at most one open Run, ever.
 *
 * The payload is the stream's payload slice — GitHub's own shapes, kept opaque
 * here; the expression and loop-file blocks range over it.
 */
export class Event extends Schema.Class<Event>("Event")({
  id: EventId,
  dedupKey: DedupKey,
  payload: Schema.Json,
  receivedAt: Schema.DateTimeUtc,
}) {}
