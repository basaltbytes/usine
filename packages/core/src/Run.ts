import { Schema } from "effect";
import { DedupKey, EventId } from "./Event.ts";
import { LoopName } from "./Loop.ts";
import { RunState } from "./RunState.ts";

/**
 * Identity of one Run.
 */
export const RunId = Schema.NonEmptyString.pipe(Schema.brand("RunId"));
export type RunId = typeof RunId.Type;

/**
 * The work a loop owes one Event. At most one open run exists per dedup key,
 * ever — the engine's ledger enforces it (ADR 0002). The dedup key is carried
 * here so that invariant is expressible over runs alone.
 */
export class Run extends Schema.Class<Run>("Run")({
  id: RunId,
  eventId: EventId,
  dedupKey: DedupKey,
  loop: LoopName,
  state: RunState,
  openedAt: Schema.DateTimeUtc,
}) {}
