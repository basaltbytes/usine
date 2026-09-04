import { Schema } from "effect";
import { AgentName } from "../ids.ts";
import { BrainSpec } from "./brain.ts";

/** SDK-local identity of one parent or child agent session. */
export const AgentSessionId = Schema.NonEmptyString.pipe(Schema.brand("AgentSessionId"));
export type AgentSessionId = typeof AgentSessionId.Type;

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** Maximum child sessions one Attempt may spawn. */
export const ChildSessionBudget = PositiveInt.pipe(Schema.brand("ChildSessionBudget"));
export type ChildSessionBudget = typeof ChildSessionBudget.Type;

/** Cumulative child-session spawn ordinal within one Attempt. */
export const ChildSessionCount = PositiveInt.pipe(Schema.brand("ChildSessionCount"));
export type ChildSessionCount = typeof ChildSessionCount.Type;

/** Parent session descriptor. It cannot name a parent, so recursive nesting is unrepresentable. */
export class ParentSession extends Schema.TaggedClass<ParentSession>("Agent/ParentSession")(
  "ParentSession",
  {
    id: AgentSessionId,
    agent: AgentName,
    brain: BrainSpec,
  },
) {}

/** Child session descriptor. Exactly one parent id keeps session nesting one level deep. */
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

/** Billing source whose native meter produced a usage or health observation. */
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

/** Latest native billing-pool rate windows observed during one session. */
export class PoolRateLimitsUpdated extends Schema.TaggedClass<PoolRateLimitsUpdated>(
  "Agent/PoolRateLimitsUpdated",
)("PoolRateLimitsUpdated", {
  session: AgentSession,
  pool: BillingPool,
  rateLimits: RateLimitsSnapshot,
}) {}

/** Normalized events emitted by every parent and child SDK backend. */
export const AgentSessionEvent = Schema.Union([
  SessionStarted,
  TextOutput,
  ToolStarted,
  ToolFinished,
  PoolRateLimitsUpdated,
  SessionFinished,
]);
export type AgentSessionEvent = typeof AgentSessionEvent.Type;
