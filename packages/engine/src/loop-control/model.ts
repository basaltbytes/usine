import { LoopName } from "@usine/core/loop";
import { Schema } from "effect";

/** The runtime state of a Loop, not stored in Loop files. */
export class LoopRuntimeState extends Schema.Class<LoopRuntimeState>(
  "@usine/engine/LoopRuntimeState",
)({
  loop: LoopName,
  paused: Schema.Boolean,
}) {}
