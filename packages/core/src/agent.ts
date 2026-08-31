import { Option, Schema } from "effect";

const nonBlankString = (message: string) =>
  Schema.String.check(Schema.isPattern(/\S/u, { message }));

/** Value object: the filename-keyed identity of one rostered Agent. */
export const Name = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, {
    message: "Expected a kebab-case Agent name",
  }),
).pipe(Schema.brand("AgentName"));
export type Name = typeof Name.Type;

/** Value object: an opaque vendor model identifier. */
export const ModelId = nonBlankString("Expected a non-blank model id").pipe(
  Schema.brand("ModelId"),
);
export type ModelId = typeof ModelId.Type;

/** Value object: standing Markdown instructions for one Agent. */
export const Persona = nonBlankString("Expected a non-blank Agent persona").pipe(
  Schema.brand("AgentPersona"),
);
export type Persona = typeof Persona.Type;

export const HARNESSES = ["claude", "codex", "pi"] as const;
export const Harness = Schema.Literals(HARNESSES);
export type Harness = typeof Harness.Type;

export const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const Effort = Schema.Literals(EFFORTS);
export type Effort = typeof Effort.Type;

/** Value object: the harness child that a run is declared to spawn. */
export class BrainSpec extends Schema.Class<BrainSpec>("Agent/BrainSpec")({
  harness: Harness,
  model: ModelId,
  effort: Effort,
}) {}

/** Entity: one named member of the instance's authored team roster. */
export class Agent extends Schema.Class<Agent>("Agent")({
  name: Name,
  harness: Harness,
  model: ModelId,
  effort: Effort,
  parentModel: Schema.Option(ModelId),
  persona: Persona,
}) {}

/** Pure deriver: the child brain declared by one rostered Agent. */
export const brainOf = (agent: Agent): BrainSpec =>
  new BrainSpec({ harness: agent.harness, model: agent.model, effort: agent.effort });

/** Pure deriver: a per-Agent parent override wins over the instance default. */
export const resolveParentModel = (
  agent: Agent,
  instanceDefault: Option.Option<ModelId>,
): Option.Option<ModelId> => Option.firstSomeOf([agent.parentModel, instanceDefault]);
