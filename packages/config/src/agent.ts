import { Agent, AgentPersona, AgentName } from "@usine/core/agent";
import { BrainSpec, Effort, Harness, ModelId } from "@usine/core/agent/brain";
import { Schema } from "effect";
import { InstancePath, ConfigFileError } from "./file.ts";

/** A parsed agent Markdown file; `name` comes from the filename. */
export class AgentFile extends Schema.Class<AgentFile>("@usine/config/AgentFile")({
  /** The agent name derived from its Markdown filename. */
  name: AgentName,
  /** The CLI used to run the agent as a child session. */
  harness: Harness,
  /** The child model identifier passed to the harness. */
  model: ModelId,
  /** The reasoning effort requested for the child model. */
  effort: Effort,
  /** The Pi parent model override, or `None` to use the instance default. */
  parentModel: Schema.Option(ModelId),
  /** The Pi parent reasoning effort override, or `None` to use the instance default. */
  parentEffort: Schema.Option(Effort),
  /** The standing instructions from the Markdown body. */
  persona: AgentPersona,
}) {
  /** Returns the runtime agent with this persona, child brain, and parent overrides. */
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

/** An agent file that failed to load and is left out of the roster. */
export class InvalidAgent extends Schema.Class<InvalidAgent>("@usine/config/InvalidAgent")({
  /** The rejected file path relative to the instance folder. */
  file: InstancePath,
  /** The loading or validation failure that excluded this file. */
  error: ConfigFileError,
}) {}
