import { type Brand, Effect, Option, Schema } from "effect";
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

/** The billing source for a session's model requests (ADR 0013). */
export const BillingPool = Schema.Literals(["apiKeys", "claudePlan", "chatgptPlan"] as const);
export type BillingPool = typeof BillingPool.Type;

/** The configured provider name of a model endpoint, excluding its URL and credentials. */
export const EndpointName = Schema.NonEmptyString.pipe(Schema.brand("EndpointName"));
export type EndpointName = typeof EndpointName.Type;

const sessionBilling = {
  /** The billing pool resolved at launch, or `None` in older records. */
  pool: Schema.OptionFromOptionalKey(BillingPool).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none<BillingPool>())),
  ),
  /** The model endpoint's provider name, or `None` for a plan or an older record. */
  endpoint: Schema.OptionFromOptionalKey(EndpointName).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none<EndpointName>())),
  ),
};

/** The Pi session that supervises the attempt and starts its child sessions. */
export class ParentSession extends Schema.TaggedClass<
  ParentSession,
  Brand.Brand<"@usine/core/agent/session/ParentSession">
>("Agent/ParentSession")("ParentSession", {
  /** The usine session ID used to correlate the parent's events. */
  id: AgentSessionId,
  /** The agent definition selected for the parent. */
  agent: AgentName,
  /** The Pi brain actually selected for this parent session. */
  brain: BrainSpec,
  ...sessionBilling,
}) {}

/** A session spawned by the parent session; a child can't spawn children. */
export class ChildSession extends Schema.TaggedClass<
  ChildSession,
  Brand.Brand<"@usine/core/agent/session/ChildSession">
>("Agent/ChildSession")("ChildSession", {
  /** The usine session ID used to correlate the child's events. */
  id: AgentSessionId,
  /** The usine session ID of the parent that started this child. */
  parentId: AgentSessionId,
  /** The agent definition selected for the child. */
  agent: AgentName,
  /** The harness, model, and effort selected for this child. */
  brain: BrainSpec,
  ...sessionBilling,
  /**
   * The credential kind injected by a gateway, a sandbox, or an attempt API key, or `None` if
   * the child used its harness's own login or the record is older.
   */
  gatewayCredential: Schema.OptionFromOptionalKey(GatewayCredentialKind).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none<GatewayCredentialKind>())),
  ),
}) {}

/** The kebab-case name of the role a session plays, such as `decision`. */
export const RoleName = Schema.NonEmptyString.check(
  Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u, { message: "Expected a kebab-case name" }),
).pipe(Schema.brand("RoleName"));
export type RoleName = typeof RoleName.Type;

/**
 * A session that a role opens through the harness seam, outside the parent and child tree. Older
 * transcripts record only `ParentSession` and `ChildSession`.
 */
export class RoleSession extends Schema.TaggedClass<
  RoleSession,
  Brand.Brand<"@usine/core/agent/session/RoleSession">
>("Agent/RoleSession")("RoleSession", {
  /** The usine session ID used to correlate the session's events. */
  id: AgentSessionId,
  /** The role that opened the session. */
  role: RoleName,
  /** The session this one acts for, such as the child a decision session follows. */
  parentId: Schema.OptionFromOptionalKey(AgentSessionId).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none<AgentSessionId>())),
  ),
  /** The agent definition whose brain the session runs. */
  agent: AgentName,
  /** The harness, model, and effort selected for this session. */
  brain: BrainSpec,
  ...sessionBilling,
}) {}

/** The identity, agent, and selected brain of a parent, child, or role session. */
export const AgentSession = Schema.Union([ParentSession, ChildSession, RoleSession]);
export type AgentSession = typeof AgentSession.Type;

/** The harness's ID for its saved conversation, distinct from `AgentSessionId`. */
export const HarnessSessionId = Schema.NonEmptyString.pipe(Schema.brand("HarnessSessionId"));
export type HarnessSessionId = typeof HarnessSessionId.Type;

/** A saved harness conversation; `cwd` is the Worker checkout to resume it from. */
export class HarnessSession extends Schema.Class<
  HarnessSession,
  Brand.Brand<"@usine/core/agent/session/HarnessSession">
>("Agent/HarnessSession")({
  /** The harness's own saved-conversation ID, distinct from the usine session ID. */
  id: HarnessSessionId.pipe(
    // Native references exist before an SDK has emitted any messages.
    // @effect-diagnostics-next-line cryptoRandomUUIDInEffect:off
    Schema.withConstructorDefault(Effect.sync(() => crypto.randomUUID())),
  ),
  /** The worker checkout directory from which to resume the conversation. */
  cwd: Schema.NonEmptyString,
  /**
   * The directory the harness saved the conversation in: its configured home or a known host
   * default, such as `HOME/.codex`. `None` when the host's default is unknown or in older records.
   */
  home: Schema.OptionFromOptionalKey(Schema.NonEmptyString).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none<string>())),
  ),
  /** The native model provider ID checked on continuation, separate from its credential. */
  modelProvider: Schema.OptionFromOptionalKey(EndpointName).pipe(
    Schema.withConstructorDefault(Effect.succeedNone),
  ),
}) {}

/** The session identity and the brain selected at launch. */
export class SessionStarted extends Schema.TaggedClass<
  SessionStarted,
  Brand.Brand<"@usine/core/agent/session/SessionStarted">
>("Agent/SessionStarted")("SessionStarted", {
  /** The session identity and brain settings selected at launch. */
  session: AgentSession,
  /** The exact initial child prompt; `None` for parents and older transcripts. */
  prompt: Schema.OptionFromOptionalKey(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none<string>())),
  ),
  /** `None` for older transcripts and for harnesses without a saved conversation. */
  harnessSession: Schema.OptionFromOptionalKey(HarnessSession).pipe(
    Schema.withConstructorDefault(Effect.succeedNone),
  ),
}) {}

/** Completed assistant text, which can come before the final result. */
export class TextOutput extends Schema.TaggedClass<
  TextOutput,
  Brand.Brand<"@usine/core/agent/session/TextOutput">
>("Agent/TextOutput")("TextOutput", {
  /** The session that produced the assistant text. */
  session: AgentSession,
  /** The completed assistant text; it need not be the session's final result. */
  text: Schema.NonEmptyString,
}) {}

/** The start of a tool call; `callId` matches the corresponding `ToolFinished`. */
export class ToolStarted extends Schema.TaggedClass<
  ToolStarted,
  Brand.Brand<"@usine/core/agent/session/ToolStarted">
>("Agent/ToolStarted")("ToolStarted", {
  /** The session that requested the tool call. */
  session: AgentSession,
  /** The harness call ID that correlates this request with `ToolFinished`. */
  callId: Schema.NonEmptyString,
  /** The tool name reported by the harness. */
  tool: Schema.NonEmptyString,
  /** The normalized JSON arguments supplied to the tool. */
  input: Schema.Json,
}) {}

/** The result of a tool call; `isError` doesn't end the session. */
export class ToolFinished extends Schema.TaggedClass<
  ToolFinished,
  Brand.Brand<"@usine/core/agent/session/ToolFinished">
>("Agent/ToolFinished")("ToolFinished", {
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
}) {}

/** The end of a session's activity; the Attempt's outcome is recorded separately. */
export class SessionFinished extends Schema.TaggedClass<
  SessionFinished,
  Brand.Brand<"@usine/core/agent/session/SessionFinished">
>("Agent/SessionFinished")("SessionFinished", {
  /** The session whose activity ended; the attempt's outcome is separate. */
  session: AgentSession,
  /**
   * Whether the session returned its answer because its wait for background work passed the
   * configured limit. Cleanup then salvages the Attempt's checkout even after a success.
   */
  backgroundWaitLimitPassed: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
    Schema.withConstructorDefault(Effect.succeed(false)),
  ),
}) {}

/** A supervised session that finished a turn and accepts more operator messages. */
export class SessionIdle extends Schema.TaggedClass<
  SessionIdle,
  Brand.Brand<"@usine/core/agent/session/SessionIdle">
>("Agent/SessionIdle")("SessionIdle", {
  /** The supervised session that finished a turn and accepts operator input. */
  session: AgentSession,
  /** The completed report to return if the operator releases this session without another turn. */
  message: Schema.OptionFromOptionalKey(Schema.NonEmptyString).pipe(
    Schema.withConstructorDefault(Effect.succeedNone),
  ),
  /**
   * Whether `message` replies to an operator message or steer that the session read after its last
   * tool call (ADR 0018).
   */
  answeredOperator: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
    Schema.withConstructorDefault(Effect.succeed(false)),
  ),
}) {}

/** A live session that started another user turn in the same conversation. */
export class SessionResumed extends Schema.TaggedClass<
  SessionResumed,
  Brand.Brand<"@usine/core/agent/session/SessionResumed">
>("Agent/SessionResumed")("SessionResumed", {
  /** The session that began another user turn in the same conversation. */
  session: AgentSession,
}) {}

/** An estimated amount in US dollars from a rate table, not a bill (ADR 0013). */
export const UsdAmount = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand("UsdAmount"),
);
export type UsdAmount = typeof UsdAmount.Type;

const TokenTally = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** A session's cumulative tokens per billing rate; each token counts in one field only. */
export class TokenBreakdown extends Schema.Class<
  TokenBreakdown,
  Brand.Brand<"@usine/core/agent/session/TokenBreakdown">
>("Agent/TokenBreakdown")({
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
export class SessionTokensUpdated extends Schema.TaggedClass<
  SessionTokensUpdated,
  Brand.Brand<"@usine/core/agent/session/SessionTokensUpdated">
>("Agent/SessionTokensUpdated")("SessionTokensUpdated", {
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
  /** The current Claude process's cumulative usage, used when reattaching that process. */
  processUsage: Schema.OptionFromOptionalKey(
    Schema.Struct({
      totalTokens: TokenCount,
      costUsd: Schema.OptionFromNullOr(UsdAmount),
      /**
       * Tokens counted per assistant message ID that can recur or remain uncheckpointed.
       * A reattached process can replay these messages, and they are not counted again.
       */
      messages: Schema.optionalKey(Schema.Record(Schema.String, TokenCount)),
    }),
  ).pipe(Schema.withConstructorDefault(Effect.succeedNone)),
}) {}

/** Returns the recorded pool, using the historical inference only for older sessions. */
export const sessionPool = (session: AgentSession): BillingPool =>
  Option.getOrElse(session.pool, () => {
    const credential = session._tag === "ChildSession" ? session.gatewayCredential : Option.none();
    switch (session.brain.harness) {
      case "claude":
        return Option.contains(credential, "api-key") ? "apiKeys" : "claudePlan";
      case "codex":
        return Option.contains(credential, "api-key") ? "apiKeys" : "chatgptPlan";
      case "pi":
        return session.brain.model.startsWith("openai-codex/") ? "chatgptPlan" : "apiKeys";
      default:
        throw new Error(`No legacy billing pool for harness "${session.brain.harness}"`);
    }
  });

/** One provider-reported allowance window, including usage outside usine. */
export class RateLimitWindow extends Schema.Class<
  RateLimitWindow,
  Brand.Brand<"@usine/core/agent/session/RateLimitWindow">
>("Agent/RateLimitWindow")({
  /** The percentage of the allowance used, including usage outside this Attempt. */
  usedPercent: Schema.Finite,
  /** The length of this allowance window in minutes, or `None` if unreported. */
  windowDurationMinutes: Schema.OptionFromNullOr(Schema.Finite),
  /** The provider-reported reset time, or `None` if unreported. */
  resetsAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
}) {}

/** The rate-limit windows from one provider report; a window is `None` if not reported. */
export class RateLimitsSnapshot extends Schema.Class<
  RateLimitsSnapshot,
  Brand.Brand<"@usine/core/agent/session/RateLimitsSnapshot">
>("Agent/RateLimitsSnapshot")({
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
export class PoolRateLimitsUpdated extends Schema.TaggedClass<
  PoolRateLimitsUpdated,
  Brand.Brand<"@usine/core/agent/session/PoolRateLimitsUpdated">
>("Agent/PoolRateLimitsUpdated")("PoolRateLimitsUpdated", {
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
export class ProviderRetrying extends Schema.TaggedClass<
  ProviderRetrying,
  Brand.Brand<"@usine/core/agent/session/ProviderRetrying">
>("Agent/ProviderRetrying")("ProviderRetrying", {
  /** The session whose harness is retrying a model provider request. */
  session: AgentSession,
  /** The harness's failure message, verbatim if it provides one. */
  message: Schema.NonEmptyString,
  /** The retries reported in the current turn, including this one. */
  retries: ProviderRetries,
}) {}

/** A model provider response after a `ProviderRetrying` in the same turn. */
export class ProviderRecovered extends Schema.TaggedClass<
  ProviderRecovered,
  Brand.Brand<"@usine/core/agent/session/ProviderRecovered">
>("Agent/ProviderRecovered")("ProviderRecovered", {
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
