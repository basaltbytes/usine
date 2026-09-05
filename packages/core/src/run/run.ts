import { Schema } from "effect";
import { EventId } from "../event.ts";
import { LoopName } from "../loop.ts";
import { RunState } from "./state.ts";

/** Identity of the work owed to one Event, retained across retries of its Step. */
export const RunId = Schema.NonEmptyString.pipe(Schema.brand("RunId"));

export type RunId = typeof RunId.Type;

/** The work a loop owes one Event. At most one open Run exists per dedup key; the engine's ledger enforces it (ADR 0002). */
export class Run extends Schema.Class<Run>("Run")({
  id: RunId,
  eventId: EventId,
  loop: LoopName,
  state: RunState,
  openedAt: Schema.DateTimeUtc,
}) {}
