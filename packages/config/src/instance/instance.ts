import { Option, Schema } from "effect";
import { UsineConfig } from "../factory.ts";
import { LoopFile, QuarantinedLoop, loopPath } from "../loop.ts";
import { AgentFile, InvalidAgent } from "../agent.ts";
import { ConfigWarning } from "./diagnostics.ts";
import { referenceIndex, loopReferenceFailure } from "./references.ts";

/** One atomic snapshot of an instance folder. Loops with unresolved references are unconstructible. */
export class LoadedInstance extends Schema.Class<LoadedInstance>("@usine/config/LoadedInstance")(
  Schema.Struct({
    config: UsineConfig,
    agents: Schema.Array(AgentFile),
    invalidAgents: Schema.Array(InvalidAgent),
    loops: Schema.Array(LoopFile),
    quarantinedLoops: Schema.Array(QuarantinedLoop),
    warnings: Schema.Array(ConfigWarning),
  }).check(
    Schema.makeFilter(
      ({ agents, config, loops }) => {
        const references = referenceIndex(config, agents);
        return loops.every((loop) =>
          Option.isNone(loopReferenceFailure(loopPath(loop.name), loop, references)),
        );
      },
      { message: "Expected every loop to reference the loaded roster and registry" },
    ),
  ),
) {}

export {
  UndeclaredLaneLabelWarning,
  UndeclaredTriggerLabelWarning,
  ConfigWarning,
} from "./diagnostics.ts";
