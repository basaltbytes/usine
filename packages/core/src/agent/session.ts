import { Schema } from "effect";
import { AgentName } from "./agent.ts";
import { BrainSpec } from "./brain.ts";

/** The SDK's own id for a parent or child session. */
export const AgentSessionId = Schema.NonEmptyString.pipe(Schema.brand("AgentSessionId"));
export type AgentSessionId = typeof AgentSessionId.Type;

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** Maximum child sessions one Attempt may spawn. */
export const ChildSessionBudget = PositiveInt.pipe(Schema.brand("ChildSessionBudget"));
export type ChildSessionBudget = typeof ChildSessionBudget.Type;

/** How many child sessions the Attempt has spawned so far, counting this one. */
export const ChildSessionCount = PositiveInt.pipe(Schema.brand("ChildSessionCount"));
export type ChildSessionCount = typeof ChildSessionCount.Type;

/** The parent session. It cannot name a parent, so nesting stays one level deep. */
export class ParentSession extends Schema.TaggedClass<ParentSession>("Agent/ParentSession")(
  "ParentSession",
  {
    id: AgentSessionId,
    agent: AgentName,
    brain: BrainSpec,
  },
) {}

/** A child session with exactly one parent. */
export class ChildSession extends Schema.TaggedClass<ChildSession>("Agent/ChildSession")(
  "ChildSession",
  {
    id: AgentSessionId,
    parentId: AgentSessionId,
    agent: AgentName,
    brain: BrainSpec,
  },
) {}

export const AgentSession = Schema.Union([ParentSession, ChildSession]);
export type AgentSession = typeof AgentSession.Type;

export class SessionStarted extends Schema.TaggedClass<SessionStarted>("Agent/SessionStarted")(
  "SessionStarted",
  { session: AgentSession },
) {}

export class TextOutput extends Schema.TaggedClass<TextOutput>("Agent/TextOutput")("TextOutput", {
  session: AgentSession,
  text: Schema.NonEmptyString,
}) {}

export class ToolStarted extends Schema.TaggedClass<ToolStarted>("Agent/ToolStarted")(
  "ToolStarted",
  {
    session: AgentSession,
    callId: Schema.NonEmptyString,
    tool: Schema.NonEmptyString,
    input: Schema.Json,
  },
) {}

export class ToolFinished extends Schema.TaggedClass<ToolFinished>("Agent/ToolFinished")(
  "ToolFinished",
  {
    session: AgentSession,
    callId: Schema.NonEmptyString,
    tool: Schema.NonEmptyString,
    output: Schema.Json,
    isError: Schema.Boolean,
  },
) {}

export class SessionFinished extends Schema.TaggedClass<SessionFinished>("Agent/SessionFinished")(
  "SessionFinished",
  { session: AgentSession },
) {}

/** The billing source whose meter produced a usage or rate-limit observation. */
export const BillingPool = Schema.Literals(["apiKeys", "claudePlan", "chatgptPlan"] as const);
export type BillingPool = typeof BillingPool.Type;

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

/** The latest rate windows observed for a billing pool during one session. */
export class PoolRateLimitsUpdated extends Schema.TaggedClass<PoolRateLimitsUpdated>(
  "Agent/PoolRateLimitsUpdated",
)("PoolRateLimitsUpdated", {
  session: AgentSession,
  pool: BillingPool,
  rateLimits: RateLimitsSnapshot,
}) {}

/** The normalized events every parent and child SDK backend emits. */
export const AgentSessionEvent = Schema.Union([
  SessionStarted,
  TextOutput,
  ToolStarted,
  ToolFinished,
  PoolRateLimitsUpdated,
  SessionFinished,
]);
export type AgentSessionEvent = typeof AgentSessionEvent.Type;
