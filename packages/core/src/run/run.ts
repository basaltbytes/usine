import { Schema } from "effect";
import { EventId } from "../event.ts";
import { LoopName } from "../loop.ts";
import { RunState } from "./state.ts";

/** The ID of a Run, unchanged across retries of its Step. */
export const RunId = Schema.NonEmptyString.pipe(Schema.brand("RunId"));

export type RunId = typeof RunId.Type;

/** The work a Loop does for one Event. The engine allows at most one open Run per dedup key (ADR 0002). */
export class Run extends Schema.Class<Run>("Run")({
  /** The run's identity, unchanged across retries of its step. */
  id: RunId,
  /** The event for which this run was opened. */
  eventId: EventId,
  /** The loop whose action this run performs. */
  loop: LoopName,
  /** The lifecycle state that determines which transitions are allowed. */
  state: RunState,
  /** The time the engine opened this run. */
  openedAt: Schema.DateTimeUtc,
}) {}
