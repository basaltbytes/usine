import { Option, Schema } from "effect";
import { AgentName } from "../ids.ts";
import { BrainSpec, Effort, ModelId } from "./brain.ts";

/** Standing Markdown instructions for one Agent. */
export const AgentPersona = Schema.String.check(
  Schema.isPattern(/\S/u, { message: "Expected a non-blank Agent persona" }),
).pipe(Schema.brand("AgentPersona"));
export type AgentPersona = typeof AgentPersona.Type;

/** One named member of the instance's authored team roster. */
export class Agent extends Schema.Class<Agent>("Agent")({
  name: AgentName,
  brain: BrainSpec,
  parentModel: Schema.OptionFromNullOr(ModelId),
  // Optional key, not null: agent_json rows stored before #102 have no such key.
  parentEffort: Schema.OptionFromOptionalKey(Effort),
  persona: AgentPersona,
}) {}

/** A per-Agent parent override wins over the instance default. */
export const resolveParentModel = (
  agent: Agent,
  instanceDefault: Option.Option<ModelId>,
): Option.Option<ModelId> => Option.firstSomeOf([agent.parentModel, instanceDefault]);

/** The roster override, then the instance default, then the child brain's effort. */
export const resolveParentEffort = (agent: Agent, instanceDefault: Option.Option<Effort>): Effort =>
  Option.getOrElse(
    Option.firstSomeOf([agent.parentEffort, instanceDefault]),
    () => agent.brain.effort,
  );
