import { Schema, Option } from "effect";
import { BrainSpec, Effort, ModelId } from "./brain.ts";

/** The kebab-case name of an Agent, taken from its filename. */
export const AgentName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, {
    message: "Expected a kebab-case agent name",
  }),
).pipe(Schema.brand("AgentName"));

export type AgentName = typeof AgentName.Type;

/**
 * Returns the signature line that ends every GitHub comment, issue, pull request, or review the
 * Agent writes. Harvesting uses it to separate Agents that post as the same bot login.
 */
export const githubSignature = (agent: AgentName): string => `— usine agent: ${agent}`;

/** The Agent's standing Markdown instructions. */
export const AgentPersona = Schema.String.check(
  Schema.isPattern(/\S/u, { message: "Expected a non-blank agent persona" }),
).pipe(Schema.brand("AgentPersona"));
export type AgentPersona = typeof AgentPersona.Type;

/** A named definition of standing instructions and the brain settings for its parent and child sessions. */
export class Agent extends Schema.Class<Agent>("Agent")({
  /** The agent's identity in the roster. */
  name: AgentName,
  /** The harness, model, and effort of the Agent's child sessions. */
  brain: BrainSpec,
  /** The model of the Pi parent session, or `None` for the instance default. */
  parentModel: Schema.OptionFromNullOr(ModelId),
  // Optional key rather than null: older stored agent rows have no such key.
  /** The parent session's reasoning effort, or `None` for the instance default, then `brain.effort`. */
  parentEffort: Schema.OptionFromOptionalKey(Effort),
  /** The standing Markdown instructions included with its tasks. */
  persona: AgentPersona,
}) {}

/** Returns the Agent's `parentModel`, else the instance default. Returns `None` if neither is set, so Pi selects the model. */
export const resolveParentModel = (
  agent: Agent,
  instanceDefault: Option.Option<ModelId>,
): Option.Option<ModelId> => Option.firstSomeOf([agent.parentModel, instanceDefault]);

/** Returns the Agent's `parentEffort`, else the instance default, else `brain.effort`. */
export const resolveParentEffort = (agent: Agent, instanceDefault: Option.Option<Effort>): Effort =>
  Option.getOrElse(
    Option.firstSomeOf([agent.parentEffort, instanceDefault]),
    () => agent.brain.effort,
  );
