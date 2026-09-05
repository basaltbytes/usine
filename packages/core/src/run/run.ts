import { Schema } from "effect";
import { EventId } from "../event.ts";
import { LoopName } from "../loop.ts";
import { RunState } from "./state.ts";

/** Identity of one Run. */
export const RunId = Schema.NonEmptyString.pipe(Schema.brand("RunId"));

export type RunId = typeof RunId.Type;

/**
 * Ledger row: the work a loop owes one Event. At most one open run exists per
 * dedup key, ever — the Event owns the key; the engine's ledger enforces the
 * invariant (ADR 0002).
 */
export class Run extends Schema.Class<Run>("Run")({
  id: RunId,
  eventId: EventId,
  loop: LoopName,
  state: RunState,
  openedAt: Schema.DateTimeUtc,
}) {}
