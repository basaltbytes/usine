import { Effect, Match, Option, Schema } from "effect";
import { GatewayCredentialKind } from "../worker.ts";
import { AgentName } from "./agent.ts";
import { BrainSpec } from "./brain.ts";

/** The usine ID of a parent or child session, distinct from `HarnessSessionId`. */
export const AgentSessionId = Schema.NonEmptyString.pipe(Schema.brand("AgentSessionId"));
export type AgentSessionId = typeof AgentSessionId.Type;

/** The sum of output tokens and uncached input tokens (new prompt text and cache writes), excluding cache reads. */
export const TokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand("TokenCount"),
);
export type TokenCount = typeof TokenCount.Type;

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** The maximum number of child sessions per Attempt, counting sequential spawns. */
export const ChildSessionBudget = PositiveInt.pipe(Schema.brand("ChildSessionBudget"));
export type ChildSessionBudget = typeof ChildSessionBudget.Type;

/** The 1-based number of a child spawn request in an Attempt, counting requests the budget rejected. */
export const ChildSessionCount = PositiveInt.pipe(Schema.brand("ChildSessionCount"));
export type ChildSessionCount = typeof ChildSessionCount.Type;

export class ParentSession extends Schema.TaggedClass<ParentSession>("Agent/ParentSession")(
  "ParentSession",
  {
    id: AgentSessionId,
    agent: AgentName,
    brain: BrainSpec,
  },
) {}

/** A session spawned by the parent session; a child can't spawn children. */
export class ChildSession extends Schema.TaggedClass<ChildSession>("Agent/ChildSession")(
  "ChildSession",
  {
    id: AgentSessionId,
    parentId: AgentSessionId,
    agent: AgentName,
    brain: BrainSpec,
    /**
     * The credential kind the Gateway used for the child's model requests (ADR 0027), or `None`
     * if the child used its harness's own login or the record is older.
     */
    gatewayCredential: Schema.OptionFromOptionalKey(GatewayCredentialKind).pipe(
      Schema.withConstructorDefault(Effect.succeed(Option.none<GatewayCredentialKind>())),
    ),
  },
) {}

export const AgentSession = Schema.Union([ParentSession, ChildSession]);
export type AgentSession = typeof AgentSession.Type;

/** The harness's ID for its saved conversation, distinct from `AgentSessionId`. */
export const HarnessSessionId = Schema.NonEmptyString.pipe(Schema.brand("HarnessSessionId"));
export type HarnessSessionId = typeof HarnessSessionId.Type;

/** A saved harness conversation; `cwd` is the Worker checkout to resume it from. */
export class HarnessSession extends Schema.Class<HarnessSession>("Agent/HarnessSession")({
  id: HarnessSessionId,
  cwd: Schema.NonEmptyString,
}) {}

/** The session identity and the brain selected at launch. */
export class SessionStarted extends Schema.TaggedClass<SessionStarted>("Agent/SessionStarted")(
  "SessionStarted",
  {
    session: AgentSession,
    /** `None` for older transcripts and for harnesses without a saved conversation. */
    harnessSession: Schema.OptionFromOptionalKey(HarnessSession).pipe(
      Schema.withConstructorDefault(Effect.succeed(Option.none())),
    ),
  },
) {}

/** Completed assistant text, which can come before the final result. */
export class TextOutput extends Schema.TaggedClass<TextOutput>("Agent/TextOutput")("TextOutput", {
  session: AgentSession,
  text: Schema.NonEmptyString,
}) {}

/** The start of a tool call; `callId` matches the corresponding `ToolFinished`. */
export class ToolStarted extends Schema.TaggedClass<ToolStarted>("Agent/ToolStarted")(
  "ToolStarted",
  {
    session: AgentSession,
    callId: Schema.NonEmptyString,
    tool: Schema.NonEmptyString,
    input: Schema.Json,
  },
) {}

/** The result of a tool call; `isError` doesn't end the session. */
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

/** The end of a session's activity; the Attempt's outcome is recorded separately. */
export class SessionFinished extends Schema.TaggedClass<SessionFinished>("Agent/SessionFinished")(
  "SessionFinished",
  { session: AgentSession },
) {}

/** A supervised session that finished a turn and accepts more operator messages. */
export class SessionIdle extends Schema.TaggedClass<SessionIdle>("Agent/SessionIdle")(
  "SessionIdle",
  { session: AgentSession },
) {}

/** A live session that started another user turn in the same conversation. */
export class SessionResumed extends Schema.TaggedClass<SessionResumed>("Agent/SessionResumed")(
  "SessionResumed",
  { session: AgentSession },
) {}

/** An estimated amount in US dollars from a rate table, not a bill (ADR 0013). */
export const UsdAmount = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand("UsdAmount"),
);
export type UsdAmount = typeof UsdAmount.Type;

const TokenTally = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** A session's cumulative tokens per billing rate; each token counts in one field only. */
export class TokenBreakdown extends Schema.Class<TokenBreakdown>("Agent/TokenBreakdown")({
  /** Input tokens that are neither read from nor written to the prompt cache. */
  input: TokenTally,
  /** Input tokens read from the prompt cache. */
  cachedInput: TokenTally,
  /** Input tokens written to the prompt cache. */
  cacheWrite: TokenTally,
  /** Output tokens, including reasoning tokens. */
  output: TokenTally,
}) {}

/**
 * The session's cumulative token count and price, including later operator turns. `costUsd` is
 * `None` for harnesses that don't price usage, such as Codex, and for older transcripts.
 * `breakdown` is `None` for harnesses other than Codex and for older transcripts.
 */
export class SessionTokensUpdated extends Schema.TaggedClass<SessionTokensUpdated>(
  "Agent/SessionTokensUpdated",
)("SessionTokensUpdated", {
  session: AgentSession,
  totalTokens: TokenCount,
  costUsd: Schema.OptionFromOptionalKey(UsdAmount).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none<UsdAmount>())),
  ),
  breakdown: Schema.OptionFromOptionalKey(TokenBreakdown).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none<TokenBreakdown>())),
  ),
}) {}

export const BillingPool = Schema.Literals(["apiKeys", "claudePlan", "chatgptPlan"] as const);
export type BillingPool = typeof BillingPool.Type;

/**
 * Returns the billing pool of a session with `brain` and the Gateway credential kind, if any.
 *
 * - Claude Code: `apiKeys` if the Gateway injects an API key, otherwise `claudePlan` (ADR 0013).
 * - Codex: `apiKeys` if the Gateway injects an API key, otherwise `chatgptPlan`.
 * - Pi: `chatgptPlan` for `openai-codex/` models, otherwise `apiKeys` (ADR 0021).
 */
export const brainPool = (
  brain: BrainSpec,
  gatewayCredential: Option.Option<GatewayCredentialKind>,
): BillingPool => {
  switch (brain.harness) {
    case "claude":
      return Option.contains(gatewayCredential, "api-key") ? "apiKeys" : "claudePlan";
    case "codex":
      return Option.contains(gatewayCredential, "api-key") ? "apiKeys" : "chatgptPlan";
    case "pi":
      return brain.model.startsWith("openai-codex/") ? "chatgptPlan" : "apiKeys";
  }
};

/** Returns the billing pool of a recorded session; the parent never uses a Gateway credential. */
export const sessionPool = (session: AgentSession): BillingPool =>
  Match.valueTags(session, {
    ParentSession: ({ brain }) => brainPool(brain, Option.none()),
    ChildSession: ({ brain, gatewayCredential }) => brainPool(brain, gatewayCredential),
  });

export class RateLimitWindow extends Schema.Class<RateLimitWindow>("Agent/RateLimitWindow")({
  /** The percentage of the allowance used, including usage outside this Attempt. */
  usedPercent: Schema.Number,
  windowDurationMinutes: Schema.OptionFromNullOr(Schema.Number),
  resetsAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
}) {}

/** The rate-limit windows from one provider report; a window is `None` if not reported. */
export class RateLimitsSnapshot extends Schema.Class<RateLimitsSnapshot>(
  "Agent/RateLimitsSnapshot",
)({
  limitId: Schema.OptionFromNullOr(Schema.String),
  limitName: Schema.OptionFromNullOr(Schema.String),
  primary: Schema.OptionFromNullOr(RateLimitWindow),
  secondary: Schema.OptionFromNullOr(RateLimitWindow),
}) {}

/** The latest rate-limit windows observed for `pool` during the session. */
export class PoolRateLimitsUpdated extends Schema.TaggedClass<PoolRateLimitsUpdated>(
  "Agent/PoolRateLimitsUpdated",
)("PoolRateLimitsUpdated", {
  session: AgentSession,
  pool: BillingPool,
  rateLimits: RateLimitsSnapshot,
}) {}

/** The number of model provider retries in the current turn, starting at 1. */
export const ProviderRetries = PositiveInt.pipe(Schema.brand("ProviderRetries"));
export type ProviderRetries = typeof ProviderRetries.Type;

/**
 * A harness report of a failed model provider request that it retries, such as Codex's
 * `Reconnecting...`. The session isn't stopped or failed (ADR 0013).
 */
export class ProviderRetrying extends Schema.TaggedClass<ProviderRetrying>(
  "Agent/ProviderRetrying",
)("ProviderRetrying", {
  session: AgentSession,
  /** The harness's failure message, verbatim if it provides one. */
  message: Schema.NonEmptyString,
  /** The retries reported in the current turn, including this one. */
  retries: ProviderRetries,
}) {}

/** A model provider response after a `ProviderRetrying` in the same turn. */
export class ProviderRecovered extends Schema.TaggedClass<ProviderRecovered>(
  "Agent/ProviderRecovered",
)("ProviderRecovered", {
  session: AgentSession,
  /** The retries in the turn before the response. */
  retries: ProviderRetries,
}) {}

export const AgentSessionEvent = Schema.Union([
  SessionStarted,
  TextOutput,
  ToolStarted,
  ToolFinished,
  PoolRateLimitsUpdated,
  SessionFinished,
  SessionIdle,
  SessionResumed,
  SessionTokensUpdated,
  ProviderRetrying,
  ProviderRecovered,
]);
export type AgentSessionEvent = typeof AgentSessionEvent.Type;
