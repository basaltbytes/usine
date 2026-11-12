import { catalog } from "@usine/agents/harness";
import { Agent, AgentPersona, AgentName, CoordinatorKind, DecisionBrain } from "@usine/core/agent";
import { BrainSpec, Effort, ModelId } from "@usine/core/agent/brain";
import { type Brand, Effect, Schema } from "effect";
import { eventsWithoutParentBrain } from "./checks.ts";
import { InstancePath, ConfigFileError } from "./file.ts";

/** A parsed agent Markdown file; `name` comes from the filename. */
export class AgentFile extends Schema.Class<
  AgentFile,
  Brand.Brand<"@usine/config/agent/AgentFile">
>("@usine/config/AgentFile")(
  Schema.Struct({
    /** The agent name derived from its Markdown filename. */
    name: AgentName,
    /** The CLI used to run the agent as a child session. */
    harness: catalog.harness,
    /** The child model identifier passed to the harness. */
    model: ModelId,
    /** The reasoning effort requested for the child model. */
    effort: Effort,
    /** The Pi parent model override, or `None` to use the instance default. */
    parentModel: Schema.Option(ModelId),
    /** The Pi parent reasoning effort override, or `None` to use the instance default. */
    parentEffort: Schema.Option(Effort),
    /** The coordinator kind of the agent's attempts, or `None` to use the instance setting. */
    coordinator: Schema.OptionFromOptionalKey(CoordinatorKind).pipe(
      Schema.withConstructorDefault(Effect.succeedNone),
    ),
    /** The model and effort of the agent's decision sessions, or `None` if it has none. */
    decision: Schema.OptionFromOptionalKey(DecisionBrain).pipe(
      Schema.withConstructorDefault(Effect.succeedNone),
    ),
    /** The standing instructions from the Markdown body. */
    persona: AgentPersona,
  }).check(eventsWithoutParentBrain({ parentModel: "parentModel", parentEffort: "parentEffort" })),
) {
  /** Returns the runtime agent with this persona, child brain, and parent overrides. */
  get agent(): Agent {
    return Agent.make({
      name: this.name,
      persona: this.persona,
      brain: BrainSpec.make({ harness: this.harness, model: this.model, effort: this.effort }),
      parentModel: this.parentModel,
      parentEffort: this.parentEffort,
      coordinator: this.coordinator,
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
