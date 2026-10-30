import { Option, Schema } from "effect";
import { UsineConfig } from "../factory.ts";
import { LoopFile, QuarantinedLoop, loopPath } from "../loop.ts";
import { AgentFile, InvalidAgent } from "../agent.ts";
import { ConfigWarning } from "./diagnostics.ts";
import { referenceIndex, loopReferenceFailure } from "./references.ts";

/**
 * A snapshot of an instance folder. Construction fails if a loop references an unknown agent or
 * selector entry.
 */
export class LoadedInstance extends Schema.Class<LoadedInstance>("@usine/config/LoadedInstance")(
  Schema.Struct({
    /** The decoded registry, projects, settings, and worker definitions. */
    config: UsineConfig,
    /** Valid agents available to loop references. */
    agents: Schema.Array(AgentFile),
    /** Agent files rejected during permissive folder loading. */
    invalidAgents: Schema.Array(InvalidAgent),
    /** Valid loops with resolved agent and selector references. */
    loops: Schema.Array(LoopFile),
    /** Loops excluded because file parsing or reference validation failed. */
    quarantinedLoops: Schema.Array(QuarantinedLoop),
    /** Nonblocking diagnostics for undeclared label references. */
    warnings: Schema.Array(ConfigWarning),
  }).check(
    Schema.makeFilter(
      ({ agents, config, loops }) => {
        const references = referenceIndex(config, agents);
        if (new Set(loops.map(({ name }) => name)).size !== loops.length) return false;
        if (
          config.version === 2 &&
          !loops.every(({ name }) => config.projects.some(({ id }) => name.startsWith(`${id}/`)))
        )
          return false;
        return loops.every((loop) =>
          Option.isNone(loopReferenceFailure(loopPath(loop.name), loop, references)),
        );
      },
      { message: "Expected every loop to reference only loaded agents and registry entries" },
    ),
  ),
) {}

export {
  UndeclaredLaneLabelWarning,
  UndeclaredTriggerLabelWarning,
  ConfigWarning,
} from "./diagnostics.ts";

export { referenceIndex } from "./references.ts";
