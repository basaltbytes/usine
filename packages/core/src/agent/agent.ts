import { Schema, Option } from "effect";
import { BrainSpec, Effort, ModelId } from "./brain.ts";

/** Kebab-case name of a rostered Agent, taken from its filename. */
export const AgentName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, {
    message: "Expected a kebab-case Agent name",
  }),
).pipe(Schema.brand("AgentName"));

export type AgentName = typeof AgentName.Type;

/** Standing Markdown instructions for one Agent. */
export const AgentPersona = Schema.String.check(
  Schema.isPattern(/\S/u, { message: "Expected a non-blank Agent persona" }),
).pipe(Schema.brand("AgentPersona"));
export type AgentPersona = typeof AgentPersona.Type;

/** One named member of the instance's team roster. */
export class Agent extends Schema.Class<Agent>("Agent")({
  name: AgentName,
  brain: BrainSpec,
  parentModel: Schema.OptionFromNullOr(ModelId),
  // Optional key rather than null: older stored agent rows have no such key.
  parentEffort: Schema.OptionFromOptionalKey(Effort),
  persona: AgentPersona,
}) {}

/** The agent's parent-model override, else the instance default. */
export const resolveParentModel = (
  agent: Agent,
  instanceDefault: Option.Option<ModelId>,
): Option.Option<ModelId> => Option.firstSomeOf([agent.parentModel, instanceDefault]);

/** The agent's parent-effort override, else the instance default, else the child brain's effort. */
export const resolveParentEffort = (agent: Agent, instanceDefault: Option.Option<Effort>): Effort =>
  Option.getOrElse(
    Option.firstSomeOf([agent.parentEffort, instanceDefault]),
    () => agent.brain.effort,
  );
