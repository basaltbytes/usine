import { Effect, Match, Option, Schema } from "effect";
import { GatewayCredentialKind } from "../worker.ts";
import { AgentName } from "./agent.ts";
import { BrainSpec } from "./brain.ts";

/** Identity usine assigns to a parent or child session within an Attempt. */
export const AgentSessionId = Schema.NonEmptyString.pipe(Schema.brand("AgentSessionId"));
export type AgentSessionId = typeof AgentSessionId.Type;

/**
 * Tokens a session consumed: output tokens plus uncached input tokens (new
 * prompt text and cache writes). Cache reads are excluded, so the count grows
 * with work done rather than with the length of the conversation re-read on
 * every turn. Each harness computes it from its own usage report.
 */
export const TokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand("TokenCount"),
);
export type TokenCount = typeof TokenCount.Type;

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
    /**
     * The kind of credential the Gateway in front of the child's Worker paid
     * its model requests with (ADR 0027). None when the child paid with its
     * harness's own login, as on a Worker without a Gateway, and for sessions
     * recorded before it was.
     */
    gatewayCredential: Schema.OptionFromOptionalKey(GatewayCredentialKind).pipe(
      Schema.withConstructorDefault(Effect.succeed(Option.none<GatewayCredentialKind>())),
    ),
  },
) {}

/** A participant in an Attempt, with its role, Agent, and effective brain recorded. */
export const AgentSession = Schema.Union([ParentSession, ChildSession]);
export type AgentSession = typeof AgentSession.Type;

/** The identity assigned by a harness to its saved conversation, distinct from usine's session id. */
export const HarnessSessionId = Schema.NonEmptyString.pipe(Schema.brand("HarnessSessionId"));
export type HarnessSessionId = typeof HarnessSessionId.Type;

/** A saved harness conversation and the worker checkout from which it can be resumed. */
export class HarnessSession extends Schema.Class<HarnessSession>("Agent/HarnessSession")({
  id: HarnessSessionId,
  cwd: Schema.NonEmptyString,
}) {}

/** Records the session identity and brain actually selected at launch. */
export class SessionStarted extends Schema.TaggedClass<SessionStarted>("Agent/SessionStarted")(
  "SessionStarted",
  {
    session: AgentSession,
    /** Absent for older transcripts and harnesses without a saved conversation. */
    harnessSession: Schema.OptionFromOptionalKey(HarnessSession).pipe(
      Schema.withConstructorDefault(Effect.succeed(Option.none())),
    ),
  },
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

/** A supervised session finished a turn and remains available for further operator messages. */
export class SessionIdle extends Schema.TaggedClass<SessionIdle>("Agent/SessionIdle")(
  "SessionIdle",
  { session: AgentSession },
) {}

/** A live session is processing another user turn in the same conversation. */
export class SessionResumed extends Schema.TaggedClass<SessionResumed>("Agent/SessionResumed")(
  "SessionResumed",
  { session: AgentSession },
) {}

/**
 * US dollars a harness priced usage at with its own rate table: Pi from its
 * model catalog, Claude Code from the Agent SDK's bundled prices. It is the
 * harness's figure, not a bill (ADR 0013).
 */
export const UsdAmount = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand("UsdAmount"),
);
export type UsdAmount = typeof UsdAmount.Type;

/**
 * Cumulative `TokenCount` consumed by this session so far, including its later
 * operator turns. `costUsd` is the cumulative price the harness put on that
 * usage; none for a harness that prices nothing, such as Codex, and for
 * transcripts recorded before prices were.
 */
export class SessionTokensUpdated extends Schema.TaggedClass<SessionTokensUpdated>(
  "Agent/SessionTokensUpdated",
)("SessionTokensUpdated", {
  session: AgentSession,
  totalTokens: TokenCount,
  costUsd: Schema.OptionFromOptionalKey(UsdAmount).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none<UsdAmount>())),
  ),
}) {}

/** The billing source whose meter produced a usage or rate-limit observation. */
export const BillingPool = Schema.Literals(["apiKeys", "claudePlan", "chatgptPlan"] as const);
export type BillingPool = typeof BillingPool.Type;

/**
 * The billing pool a started session draws from, read from its brain and the
 * kind of credential a Gateway paid its model requests with, if one did.
 * Claude Code spends API keys when its Worker's Gateway pays with an API
 * key, and the Claude plan otherwise: with its own login, or with the
 * Gateway's subscription token (ADR 0013). Codex spends the ChatGPT plan,
 * and Pi the ChatGPT plan through its `openai-codex` provider or API keys
 * otherwise. A Pi session whose credential cannot spend that pool never
 * starts (ADR 0021).
 */
export const brainPool = (
  brain: BrainSpec,
  gatewayCredential: Option.Option<GatewayCredentialKind>,
): BillingPool => {
  switch (brain.harness) {
    case "claude":
      return Option.contains(gatewayCredential, "api-key") ? "apiKeys" : "claudePlan";
    case "codex":
      return "chatgptPlan";
    case "pi":
      return brain.model.startsWith("openai-codex/") ? "chatgptPlan" : "apiKeys";
  }
};

/**
 * The billing pool a recorded session drew from (`brainPool`): the Pi parent
 * runs in the orchestrator and pays with its own credential, and a child
 * with the credential of its Worker's Gateway when it records one.
 */
export const sessionPool = (session: AgentSession): BillingPool =>
  Match.valueTags(session, {
    ParentSession: ({ brain }) => brainPool(brain, Option.none()),
    ChildSession: ({ brain, gatewayCredential }) => brainPool(brain, gatewayCredential),
  });

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

/** How many times a harness has retried its model provider during one turn of a session, counted from 1. */
export const ProviderRetries = PositiveInt.pipe(Schema.brand("ProviderRetries"));
export type ProviderRetries = typeof ProviderRetries.Type;

/**
 * A session's harness reported that a request to its model provider failed and
 * that it will try again, such as Codex's `Reconnecting...` or a Claude Code
 * API retry. The session keeps running: nothing stops or fails it on this
 * report (ADR 0013).
 */
export class ProviderRetrying extends Schema.TaggedClass<ProviderRetrying>(
  "Agent/ProviderRetrying",
)("ProviderRetrying", {
  session: AgentSession,
  /** The harness's report of the failure, in its own words where it gives them. */
  message: Schema.NonEmptyString,
  /** Retries the harness has reported for the session's current turn, this one included. */
  retries: ProviderRetries,
}) {}

/** The session's harness got an answer from its model provider again after `ProviderRetrying` in the same turn. */
export class ProviderRecovered extends Schema.TaggedClass<ProviderRecovered>(
  "Agent/ProviderRecovered",
)("ProviderRecovered", {
  session: AgentSession,
  /** Retries the harness reported for the turn before it got an answer. */
  retries: ProviderRetries,
}) {}

/** Session activity and billing observations recorded in an Attempt's transcript. */
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
