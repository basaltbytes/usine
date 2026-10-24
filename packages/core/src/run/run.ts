import { Schema } from "effect";
import { EventId } from "../event.ts";
import { LoopName } from "../loop.ts";
import { RunState } from "./state.ts";

/** The ID of a Run, unchanged across retries of its Step. */
export const RunId = Schema.NonEmptyString.pipe(Schema.brand("RunId"));

export type RunId = typeof RunId.Type;

/** The work a Loop does for one Event. The engine allows at most one open Run per dedup key (ADR 0002). */
export class Run extends Schema.Class<Run>("Run")({
  id: RunId,
  eventId: EventId,
  loop: LoopName,
  state: RunState,
  openedAt: Schema.DateTimeUtc,
}) {}
