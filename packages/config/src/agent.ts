import { AgentPersona, AgentName } from "@usine/core/agent";
import { Effort, Harness, ModelId } from "@usine/core/agent/brain";
import { Schema } from "effect";
import { InstancePath, ConfigFileError } from "./file.ts";

/** An Agent's authored brain, parent overrides, and standing instructions, named by its Markdown filename. */
export class AgentFile extends Schema.Class<AgentFile>("@usine/config/AgentFile")({
  name: AgentName,
  harness: Harness,
  model: ModelId,
  effort: Effort,
  parentModel: Schema.Option(ModelId),
  parentEffort: Schema.Option(Effort),
  persona: AgentPersona,
}) {}

/** An Agent file excluded from the roster because it could not be loaded. */
export class InvalidAgent extends Schema.Class<InvalidAgent>("@usine/config/InvalidAgent")({
  file: InstancePath,
  error: ConfigFileError,
}) {}
