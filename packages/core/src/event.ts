import { Schema } from "effect";
import { DedupKey, EventId } from "./ids.ts";

/**
 * Ledger row: one deduplicated fact the engine may react to — a trigger
 * matching watched state, or an operator approval. An Event owns at most one
 * open Run, ever.
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
