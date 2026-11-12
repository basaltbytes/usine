import { type Brand, Effect, Schema, Option } from "effect";
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

/**
 * What coordinates an Attempt's children: a model `session`, or `events`, the event-driven
 * coordinator, which applies rules to the Attempt's lifecycle events and has no session of its own.
 */
export const CoordinatorKind = Schema.Literals(["session", "events"]);
export type CoordinatorKind = typeof CoordinatorKind.Type;

/** The coordinator kind of an instance that doesn't set one. */
export const DEFAULT_COORDINATOR: CoordinatorKind = "session";

/** The model and effort of an Agent's decision sessions, which run on the Agent's own harness. */
export class DecisionBrain extends Schema.Class<
  DecisionBrain,
  Brand.Brand<"@usine/core/agent/agent/DecisionBrain">
>("DecisionBrain")({
  /** The model identifier passed to the Agent's harness. */
  model: ModelId,
  /** The reasoning effort requested for the model. */
  effort: Effort,
}) {}

/** A named definition of standing instructions and the brain settings for its parent and child sessions. */
export class Agent extends Schema.Class<Agent, Brand.Brand<"@usine/core/agent/agent/Agent">>(
  "Agent",
)({
  /** The agent's identity in the roster. */
  name: AgentName,
  /** The harness, model, and effort of the Agent's child sessions. */
  brain: BrainSpec,
  /** The model of the Pi parent session, or `None` for the instance default. */
  parentModel: Schema.OptionFromNullOr(ModelId),
  // Optional key rather than null: older stored agent rows have no such key.
  /** The parent session's reasoning effort, or `None` for the instance default, then `brain.effort`. */
  parentEffort: Schema.OptionFromOptionalKey(Effort),
  /** The kind of coordinator for the Agent's Attempts, or `None` for the instance setting. */
  coordinator: Schema.OptionFromOptionalKey(CoordinatorKind).pipe(
    Schema.withConstructorDefault(Effect.succeedNone),
  ),
  /** The brain of the Agent's decision sessions, or `None` if the Agent has none. */
  decision: Schema.OptionFromOptionalKey(DecisionBrain).pipe(
    Schema.withConstructorDefault(Effect.succeedNone),
  ),
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

/** Returns the Agent's `coordinator`, else the instance setting. */
export const resolveCoordinator = (agent: Agent, instance: CoordinatorKind): CoordinatorKind =>
  Option.getOrElse(agent.coordinator, () => instance);
