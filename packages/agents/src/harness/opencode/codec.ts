import type { AgentSessionId, OperatorMessageId } from "@usine/core/agent/session";
import { TokenBreakdown, TokenCount, UsdAmount } from "@usine/core/agent/session";
import { DateTime, Duration, Option, Schema } from "effect";
import { AgentCapacityError } from "../../runtime.ts";
import { Receipt } from "../receipts.ts";
import type { OpenCodeEvent } from "./bridge/lines.ts";

/** Tokens as OpenCode reports them: `input` excludes the cache reads and writes. */
const OpenCodeTokens = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
  cache: Schema.Struct({ read: Schema.Finite, write: Schema.Finite }),
});
export type OpenCodeTokens = typeof OpenCodeTokens.Type;

/** An error that OpenCode reports for a step, an execution, or a retry. */
const OpenCodeError = Schema.Struct({
  type: Schema.String,
  message: Schema.String,
  status: Schema.optionalKey(Schema.Int),
  retryAfterMs: Schema.optionalKey(Schema.Int),
});
export type OpenCodeError = typeof OpenCodeError.Type;

const sessionEvent = <const Type extends string, const Fields extends Schema.Struct.Fields>(
  type: Type,
  fields: Fields,
) =>
  Schema.Struct({
    type: Schema.Literal(type),
    data: Schema.Struct({ sessionID: Schema.String, ...fields }),
  });

const SessionCreated = sessionEvent("session.created", {
  parentID: Schema.optionalKey(Schema.String),
});
const ExecutionStarted = sessionEvent("session.execution.started", {});
const ExecutionSucceeded = sessionEvent("session.execution.succeeded", {});
const ExecutionFailed = sessionEvent("session.execution.failed", { error: OpenCodeError });
const ExecutionInterrupted = sessionEvent("session.execution.interrupted", {
  reason: Schema.String,
});
const InboxDelivered = sessionEvent("session.inbox.delivered", { inboxID: Schema.String });
const TextEnded = sessionEvent("session.text.ended", { text: Schema.String });
const ToolInputStarted = sessionEvent("session.tool.input.started", {
  id: Schema.String,
  name: Schema.String,
});
const ToolCalled = sessionEvent("session.tool.called", { id: Schema.String, input: Schema.Json });
const ToolSucceeded = sessionEvent("session.tool.success", {
  id: Schema.String,
  content: Schema.Json,
});
const ToolFailed = sessionEvent("session.tool.failed", { id: Schema.String, error: OpenCodeError });
const StepEnded = sessionEvent("session.step.ended", {});
const UsageUpdated = sessionEvent("session.usage.updated", {
  cost: Schema.Finite,
  tokens: OpenCodeTokens,
});
const RetryScheduled = sessionEvent("session.retry.scheduled", {
  attempt: Schema.Int,
  at: Schema.Int,
  error: OpenCodeError,
});

/** An OpenCode event that the runtime acts on. */
export const SessionEvent = Schema.Union([
  SessionCreated,
  ExecutionStarted,
  ExecutionSucceeded,
  ExecutionFailed,
  ExecutionInterrupted,
  InboxDelivered,
  TextEnded,
  ToolInputStarted,
  ToolCalled,
  ToolSucceeded,
  ToolFailed,
  StepEnded,
  UsageUpdated,
  RetryScheduled,
]);
export type SessionEvent = typeof SessionEvent.Type;

const handledTypes: ReadonlySet<string> = new Set(
  SessionEvent.members.map((member) => member.fields.type.literal),
);

/**
 * Decodes `event`: `Some` for an event that the runtime acts on, and `None` for an event of another
 * type, which the runtime skips, or of a handled type whose fields don't decode, which `malformed`
 * marks.
 */
export const decodeEvent = (event: OpenCodeEvent) => {
  const decoded = Schema.decodeUnknownOption(SessionEvent)(event);
  return { event: decoded, malformed: Option.isNone(decoded) && handledTypes.has(event.type) };
};

/** The body of `GET /api/session/:id` and `POST /api/session`. */
export const SessionInfo = Schema.Struct({
  data: Schema.Struct({
    id: Schema.String.check(Schema.isStartingWith("ses")),
    model: Schema.optionalKey(
      Schema.Struct({
        id: Schema.String,
        providerID: Schema.String,
        variant: Schema.optionalKey(Schema.String),
      }),
    ),
  }),
});

/** The body of `GET /api/model`: the models of the configured providers. */
export const Models = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      providerID: Schema.String,
      enabled: Schema.Boolean,
      variants: Schema.Array(Schema.Struct({ id: Schema.String })),
    }),
  ),
});

/** The body of `GET /api/experimental/job`: the background work of a session tree. */
export const Jobs = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      kind: Schema.String,
      id: Schema.NonEmptyString,
      status: Schema.String,
      title: Schema.optionalKey(Schema.String),
      command: Schema.optionalKey(Schema.String),
      description: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type Job = (typeof Jobs.Type)["data"][number];

/** The body of `GET /api/session/:id/inbox`: the input that the session hasn't read. */
export const Inbox = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });

/** The body of `GET /api/session/active`: the sessions that run, by ID. */
export const ActiveSessions = Schema.Struct({
  data: Schema.Record(Schema.String, Schema.Json),
});

/** An error body of OpenCode's API. */
export const ApiError = Schema.Struct({ message: Schema.String });

/**
 * Returns the OpenCode message ID of operator message `id` in session `sessionId`. OpenCode
 * requires a `msg_` prefix and an ID that is unique in its data database; the session prefix
 * keeps the IDs of two sessions apart, and the same operator message keeps one ID.
 */
export const openCodeMessageId = (sessionId: AgentSessionId, id: OperatorMessageId): string =>
  `msg_usine_${sessionId.replaceAll(/[^A-Za-z0-9]/gu, "")}_${id.replaceAll("-", "")}`;

/** Decodes a read of operator message `id`, which `session.inbox.delivered` reports. */
export const openCodeReceipts = (id: OperatorMessageId): ReadonlyArray<Receipt> => [
  Receipt.ById({ ids: [id], at: "now", opensTurn: false }),
];

/** Returns a session's tokens per billing rate. Output includes reasoning. */
export const tokenBreakdown = (tokens: OpenCodeTokens) =>
  TokenBreakdown.make({
    input: tokens.input,
    cachedInput: tokens.cache.read,
    cacheWrite: tokens.cache.write,
    output: tokens.output + tokens.reasoning,
  });

/** Returns a session's output plus uncached input. */
export const totalTokens = (tokens: OpenCodeTokens) =>
  TokenCount.make(tokens.input + tokens.cache.write + tokens.output + tokens.reasoning);

/** Adds the cumulative usage of the sessions in a session tree. */
export const addUsage = (
  usage: ReadonlyArray<{ readonly cost: number; readonly tokens: OpenCodeTokens }>,
) => ({
  cost: UsdAmount.make(usage.reduce((sum, { cost }) => sum + cost, 0)),
  tokens: usage.reduce<OpenCodeTokens>(
    (sum, { tokens }) => ({
      input: sum.input + tokens.input,
      output: sum.output + tokens.output,
      reasoning: sum.reasoning + tokens.reasoning,
      cache: {
        read: sum.cache.read + tokens.cache.read,
        write: sum.cache.write + tokens.cache.write,
      },
    }),
    { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  ),
});

/** The error types of OpenCode's plan limits and quotas, which have no reset time. */
const LIMIT_ERRORS: ReadonlySet<string> = new Set([
  "provider.quota",
  "provider.rate-limit",
  "provider.go-limit",
  "provider.chatgpt-limit",
  "provider.free-limit",
  "provider.budget-limit",
]);

/**
 * Returns the capacity refusal of a failed execution, or `None` for another failure. A rate limit
 * that OpenCode stopped retrying, a quota, and a plan limit are capacity refusals without a reset
 * time.
 */
export const capacityFailure = (
  sessionId: AgentSessionId,
  error: OpenCodeError,
): Option.Option<AgentCapacityError> =>
  LIMIT_ERRORS.has(error.type)
    ? Option.some(
        AgentCapacityError.make({
          sessionId: Option.some(sessionId),
          message: `OpenCode's provider refused the request (${error.type}): ${error.message}`,
        }),
      )
    : Option.none();

/**
 * Returns the capacity refusal of a retry that OpenCode schedules more than `threshold` ahead, or
 * `None` for a sooner retry, which OpenCode waits for. The refusal resets at the retry time.
 */
export const distantRetry = (
  sessionId: AgentSessionId,
  retry: { readonly at: number; readonly error: OpenCodeError },
  threshold: Duration.Duration,
): Option.Option<AgentCapacityError> => {
  const after = retry.error.retryAfterMs;
  if (after === undefined || after <= Duration.toMillis(threshold)) return Option.none();
  return Option.some(
    AgentCapacityError.make({
      sessionId: Option.some(sessionId),
      message: `OpenCode's provider asked to retry in ${Math.ceil(after / 1000)} seconds (${retry.error.type}): ${retry.error.message}`,
      resetsAt: DateTime.make(retry.at),
    }),
  );
};
