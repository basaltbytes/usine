import { LoopName } from "@usine/core/loop";
import { type Brand, Schema } from "effect";

/** The runtime state of a Loop, not stored in Loop files. */
export class LoopRuntimeState extends Schema.Class<
  LoopRuntimeState,
  Brand.Brand<"@usine/engine/loop-control/model/LoopRuntimeState">
>("@usine/engine/LoopRuntimeState")({
  /** The qualified loop identity whose runtime pause state was read. */
  loop: LoopName,
  /** Whether triggers must stop opening new runs; existing runs continue. */
  paused: Schema.Boolean,
}) {}
