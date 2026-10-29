import {
  type AgentSessionEvent,
  AgentSessionId,
  type ChildSession,
  HarnessSessionId,
  TextOutput,
  ToolFinished,
  ToolStarted,
} from "@usine/core/agent/session";
import { Option, Schema } from "effect";
import { AgentCapacityError, AgentResultError, harnessFailure } from "../../runtime.ts";

export const decodeClaudeInit = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("system"),
    subtype: Schema.Literal("init"),
    session_id: HarnessSessionId,
  }),
);

const ClaudeTextBlock = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.NonEmptyString,
});
const ClaudeContentMessage = Schema.Struct({
  type: Schema.Literals(["assistant", "user"]),
  message: Schema.Struct({ content: Schema.Array(Schema.Json) }),
});
const ClaudeToolUseBlock = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  input: Schema.Json,
});
const ClaudeToolResultBlock = Schema.Struct({
  type: Schema.Literal("tool_result"),
  tool_use_id: Schema.NonEmptyString,
  content: Schema.Json,
  is_error: Schema.optionalKey(Schema.Boolean),
});
const decodeAssistantError = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("assistant"),
    error: Schema.String,
    message: Schema.Struct({ content: Schema.Array(ClaudeTextBlock) }),
  }),
);

export const ClaudeResultMessage = Schema.Struct({
  type: Schema.Literal("result"),
  subtype: Schema.String,
  result: Schema.optionalKey(Schema.String),
  errors: Schema.optionalKey(Schema.Array(Schema.String)),
  queued_turn_count: Schema.optionalKey(Schema.Number),
});
const ClaudeBackgroundTasks = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literal("background_tasks_changed"),
  tasks: Schema.Array(
    Schema.Struct({
      task_id: Schema.NonEmptyString,
      ambient: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
const ClaudeSessionState = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literal("session_state_changed"),
  state: Schema.Literals(["idle", "running", "requires_action"]),
});

export const ClaudeCompletionHeader = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literals(["background_tasks_changed", "session_state_changed"]),
});
export const decodeCompletionUpdate = Schema.decodeUnknownEffect(
  Schema.Union([ClaudeBackgroundTasks, ClaudeSessionState]),
);

/** Claude Code's report of a failed API request that it retries; a `null` status means no response was received. */
export const ClaudeApiRetry = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literal("api_retry"),
  attempt: Schema.Number,
  max_retries: Schema.Number,
  retry_delay_ms: Schema.Number,
  error_status: Schema.NullOr(Schema.Number),
  error: Schema.String,
});
export const decodeApiRetry = Schema.decodeUnknownOption(ClaudeApiRetry);
export const isAssistantMessage = Schema.is(Schema.Struct({ type: Schema.Literal("assistant") }));

/** Returns an API retry's fields as one sentence, because Claude Code includes no message. */
export const apiRetryMessage = (retry: typeof ClaudeApiRetry.Type): string => {
  const failure =
    retry.error_status === null ? "without a response" : `with HTTP ${retry.error_status}`;
  const delay =
    retry.retry_delay_ms < 1_000
      ? `${retry.retry_delay_ms}ms`
      : `${Math.round(retry.retry_delay_ms / 1_000)}s`;
  return `API request failed ${failure} (${retry.error}); retry ${retry.attempt} of ${retry.max_retries} in ${delay}`;
};

/**
 * The text Claude Code ends a turn with if another Claude process has the login refresh lock, or
 * exited while it had the lock.
 */
const LOGIN_CONTENDED = "Failed to refresh OAuth token: another Claude Code process";

/** Messages that arrive only after an API request was sent with a working login. */
const ClaudeLoginEvidence = Schema.Union([
  Schema.Struct({ type: Schema.Literals(["rate_limit_event", "stream_event"]) }),
  Schema.Struct({
    type: Schema.Literal("system"),
    subtype: Schema.Literals(["api_retry", "thinking_tokens"]),
  }),
]);

const mentionsLoginContention = (text: string): boolean => text.includes(LOGIN_CONTENDED);

/** The login state shown by a launch's messages so far. */
export type LoginCheck = "waiting" | "loggedIn" | "contended";

/**
 * Returns the login state shown by one of a launch's first messages. `init` and other session
 * notices can arrive before the first API request, where Claude refreshes an expired login, so they
 * return `waiting`. A model answer, rate-limit or thinking update, API retry, or result returns
 * `loggedIn`, except a result with the refresh lock error and no tokens used, which returns
 * `contended`. The synthetic answer with the same error returns `waiting` until that result.
 */
export const loginCheck = (message: Schema.Json, spentTokens: boolean): LoginCheck => {
  if (Schema.is(ClaudeResultMessage)(message)) {
    const reported = [
      ...(message.result === undefined ? [] : [message.result]),
      ...(message.errors ?? []),
    ];
    return !spentTokens && reported.some(mentionsLoginContention) ? "contended" : "loggedIn";
  }
  if (Schema.is(ClaudeContentMessage)(message) && message.type === "assistant") {
    const contended = message.message.content.some(
      (block) => Schema.is(ClaudeTextBlock)(block) && mentionsLoginContention(block.text),
    );
    return contended && !spentTokens ? "waiting" : "loggedIn";
  }
  return Schema.is(ClaudeLoginEvidence)(message) ? "loggedIn" : "waiting";
};

/** Returns the transcript events in `message`; `tools` names the open tool calls by ID. */
export const sessionEventsFrom = (
  message: Schema.Json,
  session: ChildSession,
  tools: Map<string, string>,
): ReadonlyArray<AgentSessionEvent> => {
  if (!Schema.is(ClaudeContentMessage)(message)) return [];
  const events: Array<AgentSessionEvent> = [];
  for (const block of message.message.content) {
    // Emits only text blocks of completed assistant messages; streaming deltas are not recorded.
    if (message.type === "assistant" && Schema.is(ClaudeTextBlock)(block)) {
      events.push(new TextOutput({ session, text: block.text }));
    } else if (Schema.is(ClaudeToolUseBlock)(block)) {
      tools.set(block.id, block.name);
      events.push(
        new ToolStarted({
          session,
          callId: block.id,
          tool: block.name,
          input: block.input,
        }),
      );
    } else if (Schema.is(ClaudeToolResultBlock)(block)) {
      events.push(
        new ToolFinished({
          session,
          callId: block.tool_use_id,
          tool: tools.get(block.tool_use_id) ?? "unknown",
          output: block.content,
          isError: block.is_error === true,
        }),
      );
      tools.delete(block.tool_use_id);
    }
  }
  return events;
};

/** Returns the capacity failure of a retry that exposes an overload code or HTTP status. */
export const apiRetryFailure = (sessionId: AgentSessionId, retry: typeof ClaudeApiRetry.Type) =>
  retry.error_status === 529 ||
  retry.error === "overloaded_error" ||
  (retry.error_status === 503 && retry.retry_delay_ms > 0)
    ? Option.some(
        new AgentCapacityError({
          sessionId: Option.some(sessionId),
          message: apiRetryMessage(retry),
        }),
      )
    : Option.none<AgentCapacityError>();

/** Uses the assistant's error code, retaining the last HTTP status for a generic server error. */
export const assistantFailure = (
  sessionId: AgentSessionId,
  message: Schema.Json,
  previous: Option.Option<AgentCapacityError | AgentResultError>,
): Option.Option<AgentCapacityError | AgentResultError> =>
  Option.map(decodeAssistantError(message), (error) => {
    const fields = {
      sessionId: Option.some(sessionId),
      message:
        error.message.content.map(({ text }) => text).join("\n") || "Claude API request failed.",
    };
    if (error.error === "overloaded") return new AgentCapacityError(fields);
    if (error.error === "server_error" || error.error === "unknown") {
      return Option.exists(previous, (failure) => failure instanceof AgentCapacityError)
        ? new AgentCapacityError(fields)
        : harnessFailure(fields.sessionId, fields.message);
    }
    return new AgentResultError(fields);
  });

/** Keeps task limits terminal even if the turn previously retried a provider request. */
export const resultFailure = (
  sessionId: AgentSessionId,
  result: typeof ClaudeResultMessage.Type,
  providerFailure: Option.Option<AgentCapacityError | AgentResultError>,
): AgentCapacityError | AgentResultError => {
  const message = result.errors?.join("; ") || "Claude returned an unsuccessful result";
  return result.subtype === "error_during_execution"
    ? Option.getOrElse(providerFailure, () => harnessFailure(Option.some(sessionId), message))
    : new AgentResultError({ sessionId: Option.some(sessionId), message });
};
