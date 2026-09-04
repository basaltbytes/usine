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
  brain: BrainSpec,
  parentModel: Schema.OptionFromNullOr(ModelId),
  // Optional key, not null: agent_json rows stored before #102 have no such key.
  parentEffort: Schema.OptionFromOptionalKey(Effort),
  persona: Persona,
}) {}

/** Value object: SDK-local identity of one parent or child agent session. */
export const SessionId = Schema.NonEmptyString.pipe(Schema.brand("AgentSessionId"));
export type SessionId = typeof SessionId.Type;

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** Value object: maximum child sessions one Attempt may spawn. */
export const ChildSessionBudget = PositiveInt.pipe(Schema.brand("ChildSessionBudget"));
export type ChildSessionBudget = typeof ChildSessionBudget.Type;

/** Value object: cumulative child-session spawn ordinal within one Attempt. */
export const ChildSessionCount = PositiveInt.pipe(Schema.brand("ChildSessionCount"));
export type ChildSessionCount = typeof ChildSessionCount.Type;

/** Parent session descriptor. It cannot name a parent, so recursive nesting is unrepresentable. */
export class ParentSession extends Schema.TaggedClass<ParentSession>("Agent/ParentSession")(
  "ParentSession",
  {
    id: SessionId,
    agent: Name,
    brain: BrainSpec,
  },
) {}

/** Child session descriptor. Exactly one parent id keeps session nesting one level deep. */
export class ChildSession extends Schema.TaggedClass<ChildSession>("Agent/ChildSession")(
  "ChildSession",
  {
    id: SessionId,
    parentId: SessionId,
    agent: Name,
    brain: BrainSpec,
  },
) {}

export const Session = Schema.Union([ParentSession, ChildSession]);
export type Session = typeof Session.Type;

export class SessionStarted extends Schema.TaggedClass<SessionStarted>("Agent/SessionStarted")(
  "SessionStarted",
  { session: Session },
) {}

export class TextOutput extends Schema.TaggedClass<TextOutput>("Agent/TextOutput")("TextOutput", {
  session: Session,
  text: Schema.NonEmptyString,
}) {}

export class ToolStarted extends Schema.TaggedClass<ToolStarted>("Agent/ToolStarted")(
  "ToolStarted",
  {
    session: Session,
    callId: Schema.NonEmptyString,
    tool: Schema.NonEmptyString,
    input: Schema.Json,
  },
) {}

export class ToolFinished extends Schema.TaggedClass<ToolFinished>("Agent/ToolFinished")(
  "ToolFinished",
  {
    session: Session,
    callId: Schema.NonEmptyString,
    tool: Schema.NonEmptyString,
    output: Schema.Json,
    isError: Schema.Boolean,
  },
) {}

export class SessionFinished extends Schema.TaggedClass<SessionFinished>("Agent/SessionFinished")(
  "SessionFinished",
  { session: Session },
) {}

/** Billing source whose native meter produced a usage or health observation. */
export const Pool = Schema.Literals(["apiKeys", "claudePlan", "chatgptPlan"] as const);
export type Pool = typeof Pool.Type;

export class RateLimitWindow extends Schema.Class<RateLimitWindow>("Agent/RateLimitWindow")({
  usedPercent: Schema.Number,
  windowDurationMinutes: Schema.OptionFromNullOr(Schema.Number),
  resetsAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
}) {}

export class RateLimitsSnapshot extends Schema.Class<RateLimitsSnapshot>(
  "Agent/RateLimitsSnapshot",
)({
  limitId: Schema.OptionFromNullOr(Schema.String),
  limitName: Schema.OptionFromNullOr(Schema.String),
  primary: Schema.OptionFromNullOr(RateLimitWindow),
  secondary: Schema.OptionFromNullOr(RateLimitWindow),
}) {}

/** Latest native billing-pool rate windows observed during one session. */
export class PoolRateLimitsUpdated extends Schema.TaggedClass<PoolRateLimitsUpdated>(
  "Agent/PoolRateLimitsUpdated",
)("PoolRateLimitsUpdated", {
  session: Session,
  pool: Pool,
  rateLimits: RateLimitsSnapshot,
}) {}

/** Normalized events emitted by every parent and child SDK backend. */
export const SessionEvent = Schema.Union([
  SessionStarted,
  TextOutput,
  ToolStarted,
  ToolFinished,
  PoolRateLimitsUpdated,
  SessionFinished,
]);
export type SessionEvent = typeof SessionEvent.Type;

/** Pure deriver: a per-Agent parent override wins over the instance default. */
export const resolveParentModel = (
  agent: Agent,
  instanceDefault: Option.Option<ModelId>,
): Option.Option<ModelId> => Option.firstSomeOf([agent.parentModel, instanceDefault]);

/** Pure deriver: the roster override, then the instance default, then the child brain's effort. */
export const resolveParentEffort = (agent: Agent, instanceDefault: Option.Option<Effort>): Effort =>
  Option.getOrElse(
    Option.firstSomeOf([agent.parentEffort, instanceDefault]),
    () => agent.brain.effort,
  );
