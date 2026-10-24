import { Agent, AgentPersona, AgentName } from "@usine/core/agent";
import { BrainSpec, Effort, Harness, ModelId } from "@usine/core/agent/brain";
import { Schema } from "effect";
import { InstancePath, ConfigFileError } from "./file.ts";

/** A parsed Agent Markdown file; `name` comes from the filename. */
export class AgentFile extends Schema.Class<AgentFile>("@usine/config/AgentFile")({
  name: AgentName,
  harness: Harness,
  model: ModelId,
  effort: Effort,
  parentModel: Schema.Option(ModelId),
  parentEffort: Schema.Option(Effort),
  persona: AgentPersona,
}) {
  get agent(): Agent {
    return new Agent({
      name: this.name,
      persona: this.persona,
      brain: new BrainSpec({ harness: this.harness, model: this.model, effort: this.effort }),
      parentModel: this.parentModel,
      parentEffort: this.parentEffort,
    });
  }
}

/** An Agent file that failed to load and is left out of the roster. */
export class InvalidAgent extends Schema.Class<InvalidAgent>("@usine/config/InvalidAgent")({
  file: InstancePath,
  error: ConfigFileError,
}) {}
