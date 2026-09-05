import { Schema } from "effect";
import { AgentName } from "./agent.ts";
import { BrainSpec } from "./brain.ts";

/** Identity usine assigns to a parent or child session within an Attempt. */
export const AgentSessionId = Schema.NonEmptyString.pipe(Schema.brand("AgentSessionId"));
export type AgentSessionId = typeof AgentSessionId.Type;

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** Maximum child sessions one Attempt may spawn over its lifetime, including sequential spawns. */
export const ChildSessionBudget = PositiveInt.pipe(Schema.brand("ChildSessionBudget"));
export type ChildSessionBudget = typeof ChildSessionBudget.Type;

/** The 1-based child spawn request number within an Attempt, including requests rejected by the budget. */
export const ChildSessionCount = PositiveInt.pipe(Schema.brand("ChildSessionCount"));
export type ChildSessionCount = typeof ChildSessionCount.Type;

/** The session coordinating an Attempt and delegating work to its coding children. */
export class ParentSession extends Schema.TaggedClass<ParentSession>("Agent/ParentSession")(
  "ParentSession",
  {
    id: AgentSessionId,
    agent: AgentName,
    brain: BrainSpec,
  },
) {}

/** A coding session delegated by the Attempt's parent; children cannot delegate to further children. */
export class ChildSession extends Schema.TaggedClass<ChildSession>("Agent/ChildSession")(
  "ChildSession",
  {
    id: AgentSessionId,
    parentId: AgentSessionId,
    agent: AgentName,
    brain: BrainSpec,
  },
) {}

/** A participant in an Attempt, with its role, Agent, and effective brain recorded. */
export const AgentSession = Schema.Union([ParentSession, ChildSession]);
export type AgentSession = typeof AgentSession.Type;

/** Records the session identity and brain actually selected at launch. */
export class SessionStarted extends Schema.TaggedClass<SessionStarted>("Agent/SessionStarted")(
  "SessionStarted",
  { session: AgentSession },
) {}

/** Completed assistant text emitted during the session, which may precede its final result. */
export class TextOutput extends Schema.TaggedClass<TextOutput>("Agent/TextOutput")("TextOutput", {
  session: AgentSession,
  text: Schema.NonEmptyString,
}) {}

/** A session began a tool call; `callId` pairs it with the corresponding result. */
export class ToolStarted extends Schema.TaggedClass<ToolStarted>("Agent/ToolStarted")(
  "ToolStarted",
  {
    session: AgentSession,
    callId: Schema.NonEmptyString,
    tool: Schema.NonEmptyString,
    input: Schema.Json,
  },
) {}

/** A tool call returned its output; a tool error does not by itself close the session. */
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

/** Marks the end of a session's activity in the transcript; the Attempt's outcome is recorded separately. */
export class SessionFinished extends Schema.TaggedClass<SessionFinished>("Agent/SessionFinished")(
  "SessionFinished",
  { session: AgentSession },
) {}

/** The billing source whose meter produced a usage or rate-limit observation. */
export const BillingPool = Schema.Literals(["apiKeys", "claudePlan", "chatgptPlan"] as const);
export type BillingPool = typeof BillingPool.Type;

/** A billing pool's observed usage for one allowance window. */
export class RateLimitWindow extends Schema.Class<RateLimitWindow>("Agent/RateLimitWindow")({
  /** Percentage of the allowance already consumed, including usage outside this Attempt. */
  usedPercent: Schema.Number,
  /** Length of the allowance window; absent when the provider omits it. */
  windowDurationMinutes: Schema.OptionFromNullOr(Schema.Number),
  /** When the allowance resets; absent when the provider omits it. */
  resetsAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
}) {}

/** The allowance windows reported together by a provider; omitted windows remain unknown. */
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

/** Session activity and billing observations recorded in an Attempt's transcript. */
export const AgentSessionEvent = Schema.Union([
  SessionStarted,
  TextOutput,
  ToolStarted,
  ToolFinished,
  PoolRateLimitsUpdated,
  SessionFinished,
]);
export type AgentSessionEvent = typeof AgentSessionEvent.Type;
