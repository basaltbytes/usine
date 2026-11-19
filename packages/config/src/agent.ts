import { catalog } from "@usine/agents/harness";
import { Agent, AgentPersona, AgentName, DecisionBrain } from "@usine/core/agent";
import { BrainSpec, Effort, ModelId } from "@usine/core/agent/brain";
import { type Brand, Effect, Schema } from "effect";
import { InstancePath, ConfigFileError } from "./file.ts";

/** A parsed agent Markdown file; `name` comes from the filename. */
export class AgentFile extends Schema.Class<
  AgentFile,
  Brand.Brand<"@usine/config/agent/AgentFile">
>("@usine/config/AgentFile")({
  /** The agent name derived from its Markdown filename. */
  name: AgentName,
  /** The CLI used to run the agent as a child session. */
  harness: catalog.harness,
  /** The child model identifier passed to the harness. */
  model: ModelId,
  /** The reasoning effort requested for the child model. */
  effort: Effort,
  /** The model and effort of the agent's decision sessions, or `None` if it has none. */
  decision: Schema.OptionFromOptionalKey(DecisionBrain).pipe(
    Schema.withConstructorDefault(Effect.succeedNone),
  ),
  /** The standing instructions from the Markdown body. */
  persona: AgentPersona,
}) {
  /** Returns the runtime agent with this persona and child brain. */
  get agent(): Agent {
    return Agent.make({
      name: this.name,
      persona: this.persona,
      brain: BrainSpec.make({ harness: this.harness, model: this.model, effort: this.effort }),
      decision: this.decision,
    });
  }
}

/** An agent file that failed to load and is left out of the roster. */
export class InvalidAgent extends Schema.Class<
  InvalidAgent,
  Brand.Brand<"@usine/config/agent/InvalidAgent">
>("@usine/config/InvalidAgent")({
  /** The rejected file path relative to the instance folder. */
  file: InstancePath,
  /** The loading or validation failure that excluded this file. */
  error: ConfigFileError,
}) {}
