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

/** The Pi session that supervises the attempt and starts its child sessions. */
export class ParentSession extends Schema.TaggedClass<ParentSession>("Agent/ParentSession")(
  "ParentSession",
  {
    /** The usine session ID used to correlate the parent's events. */
    id: AgentSessionId,
    /** The agent definition selected for the parent. */
    agent: AgentName,
    /** The Pi brain actually selected for this parent session. */
    brain: BrainSpec,
  },
) {}

/** A session spawned by the parent session; a child can't spawn children. */
export class ChildSession extends Schema.TaggedClass<ChildSession>("Agent/ChildSession")(
  "ChildSession",
  {
    /** The usine session ID used to correlate the child's events. */
    id: AgentSessionId,
    /** The usine session ID of the parent that started this child. */
    parentId: AgentSessionId,
    /** The agent definition selected for the child. */
    agent: AgentName,
    /** The harness, model, and effort selected for this child. */
    brain: BrainSpec,
    /**
     * The credential kind the Gateway (ADR 0027) or a Cloudflare Worker's outbound handler used
     * for the child's model requests, or `None` if the child used its harness's own login or the
     * record is older.
     */
    gatewayCredential: Schema.OptionFromOptionalKey(GatewayCredentialKind).pipe(
      Schema.withConstructorDefault(Effect.succeed(Option.none<GatewayCredentialKind>())),
    ),
  },
) {}

/** The identity, agent, and selected brain of a parent or first-level child session. */
export const AgentSession = Schema.Union([ParentSession, ChildSession]);
export type AgentSession = typeof AgentSession.Type;

/** The harness's ID for its saved conversation, distinct from `AgentSessionId`. */
export const HarnessSessionId = Schema.NonEmptyString.pipe(Schema.brand("HarnessSessionId"));
export type HarnessSessionId = typeof HarnessSessionId.Type;

/** A saved harness conversation; `cwd` is the Worker checkout to resume it from. */
export class HarnessSession extends Schema.Class<HarnessSession>("Agent/HarnessSession")({
  /** The harness's own saved-conversation ID, distinct from the usine session ID. */
  id: HarnessSessionId,
  /** The worker checkout directory from which to resume the conversation. */
  cwd: Schema.NonEmptyString,
  /**
   * The directory the harness saved the conversation in, if the Attempt set one in place of the
   * harness's default: Codex's `CODEX_HOME`. `None` for the default or an older record.
   */
  home: Schema.OptionFromOptionalKey(Schema.NonEmptyString).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none<string>())),
  ),
}) {}

/** The session identity and the brain selected at launch. */
export class SessionStarted extends Schema.TaggedClass<SessionStarted>("Agent/SessionStarted")(
  "SessionStarted",
  {
    /** The session identity and brain settings selected at launch. */
    session: AgentSession,
    /** `None` for older transcripts and for harnesses without a saved conversation. */
    harnessSession: Schema.OptionFromOptionalKey(HarnessSession).pipe(
      Schema.withConstructorDefault(Effect.succeed(Option.none())),
    ),
  },
) {}

/** Completed assistant text, which can come before the final result. */
export class TextOutput extends Schema.TaggedClass<TextOutput>("Agent/TextOutput")("TextOutput", {
  /** The session that produced the assistant text. */
  session: AgentSession,
  /** The completed assistant text; it need not be the session's final result. */
  text: Schema.NonEmptyString,
}) {}

/** The start of a tool call; `callId` matches the corresponding `ToolFinished`. */
export class ToolStarted extends Schema.TaggedClass<ToolStarted>("Agent/ToolStarted")(
  "ToolStarted",
  {
    /** The session that requested the tool call. */
    session: AgentSession,
    /** The harness call ID that correlates this request with `ToolFinished`. */
    callId: Schema.NonEmptyString,
    /** The tool name reported by the harness. */
    tool: Schema.NonEmptyString,
    /** The normalized JSON arguments supplied to the tool. */
    input: Schema.Json,
  },
) {}

/** The result of a tool call; `isError` doesn't end the session. */
export class ToolFinished extends Schema.TaggedClass<ToolFinished>("Agent/ToolFinished")(
  "ToolFinished",
  {
    /** The session that received the tool result. */
    session: AgentSession,
    /** The harness call ID from the corresponding `ToolStarted` event. */
    callId: Schema.NonEmptyString,
    /** The tool name reported by the harness. */
    tool: Schema.NonEmptyString,
    /** The normalized JSON result returned by the tool. */
    output: Schema.Json,
    /** Whether the tool reported an error; this does not end the session. */
    isError: Schema.Boolean,
  },
) {}

/** The end of a session's activity; the Attempt's outcome is recorded separately. */
export class SessionFinished extends Schema.TaggedClass<SessionFinished>("Agent/SessionFinished")(
  "SessionFinished",
  {
    /** The session whose activity ended; the attempt's outcome is separate. */
    session: AgentSession,
  },
) {}

/** A supervised session that finished a turn and accepts more operator messages. */
export class SessionIdle extends Schema.TaggedClass<SessionIdle>("Agent/SessionIdle")(
  "SessionIdle",
  {
    /** The supervised session that finished a turn and accepts operator input. */
    session: AgentSession,
  },
) {}

/** A live session that started another user turn in the same conversation. */
export class SessionResumed extends Schema.TaggedClass<SessionResumed>("Agent/SessionResumed")(
  "SessionResumed",
  {
    /** The session that began another user turn in the same conversation. */
    session: AgentSession,
  },
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
  /** The session whose cumulative usage this report replaces. */
  session: AgentSession,
  /** Output plus uncached input tokens across all turns, excluding cache reads. */
  totalTokens: TokenCount,
  /** The harness-reported price in US dollars, or `None` if unpriced or from an older transcript. */
  costUsd: Schema.OptionFromOptionalKey(UsdAmount).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none<UsdAmount>())),
  ),
  /** The cumulative tokens by billing rate, or `None` when the harness does not report them. */
  breakdown: Schema.OptionFromOptionalKey(TokenBreakdown).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none<TokenBreakdown>())),
  ),
}) {}

/** The billing source for a session's model requests: API keys, a Claude plan, or a ChatGPT plan (ADR 0013). */
export const BillingPool = Schema.Literals(["apiKeys", "claudePlan", "chatgptPlan"] as const);
export type BillingPool = typeof BillingPool.Type;

/**
 * Returns the billing pool of a session with `brain` and the kind of the credential that a
 * Gateway or a Cloudflare Worker's outbound handler injects, if any.
 *
 * - Claude Code: `apiKeys` if an API key is injected, otherwise `claudePlan` (ADR 0013).
 * - Codex: `apiKeys` if an API key is injected, otherwise `chatgptPlan`.
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

/** One provider-reported allowance window, including usage outside usine. */
export class RateLimitWindow extends Schema.Class<RateLimitWindow>("Agent/RateLimitWindow")({
  /** The percentage of the allowance used, including usage outside this Attempt. */
  usedPercent: Schema.Number,
  /** The length of this allowance window in minutes, or `None` if unreported. */
  windowDurationMinutes: Schema.OptionFromNullOr(Schema.Number),
  /** The provider-reported reset time, or `None` if unreported. */
  resetsAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
}) {}

/** The rate-limit windows from one provider report; a window is `None` if not reported. */
export class RateLimitsSnapshot extends Schema.Class<RateLimitsSnapshot>(
  "Agent/RateLimitsSnapshot",
)({
  /** The provider's identifier for the reported allowance, or `None`. */
  limitId: Schema.OptionFromNullOr(Schema.String),
  /** The provider's display name for the allowance, or `None`. */
  limitName: Schema.OptionFromNullOr(Schema.String),
  /** The provider's primary allowance window, or `None` if unreported. */
  primary: Schema.OptionFromNullOr(RateLimitWindow),
  /** The provider's secondary allowance window, or `None` if unreported. */
  secondary: Schema.OptionFromNullOr(RateLimitWindow),
}) {}

/** The login reported by the provider for a billing pool. */
export const PoolLogin = Schema.NonEmptyString.pipe(Schema.brand("PoolLogin"));
export type PoolLogin = typeof PoolLogin.Type;

/** The latest rate-limit windows observed for `pool` during the session. */
export class PoolRateLimitsUpdated extends Schema.TaggedClass<PoolRateLimitsUpdated>(
  "Agent/PoolRateLimitsUpdated",
)("PoolRateLimitsUpdated", {
  /** The session during which the provider reported these limits. */
  session: AgentSession,
  /** The billing source to which the reported limits apply. */
  pool: BillingPool,
  /** Absent for older records and providers that don't report a login. */
  login: Schema.OptionFromOptionalKey(PoolLogin).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none<PoolLogin>())),
  ),
  /** The provider's latest allowance windows, including usage outside usine. */
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
  /** The session whose harness is retrying a model provider request. */
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
  /** The session whose model provider responded after retries in this turn. */
  session: AgentSession,
  /** The retries in the turn before the response. */
  retries: ProviderRetries,
}) {}

/** A normalized session activity or usage report for storage in an attempt transcript. */
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
