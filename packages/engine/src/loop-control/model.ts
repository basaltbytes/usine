import { LoopName } from "@usine/core/loop";
import { Schema } from "effect";

/** Runtime state for one Loop. Authored loop files never carry this toggle. */
export class LoopRuntimeState extends Schema.Class<LoopRuntimeState>(
  "@usine/engine/LoopRuntimeState",
)({
  loop: LoopName,
  paused: Schema.Boolean,
}) {}
