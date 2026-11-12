import {
  AgentSessionId,
  RateLimitsSnapshot,
  RateLimitWindow as CoreRateLimitWindow,
} from "@usine/core/agent/session";
import { DateTime, Effect, Option, Schema } from "effect";
import {
  AgentMessageItem,
  ErrorNotification,
  isCodexErrorCode,
  type RateLimitsUpdated,
  type RateLimitWindow,
  ToolItem,
  type TurnCompleted,
  UserMessageItem,
  UserTextInput,
} from "../../protocol/codex/codex.ts";
import {
  AgentCapacityError,
  AgentResultError,
  harnessFailure,
  SessionOperationError,
} from "../../runtime.ts";
import { type CodexClient, operationError } from "./app-server.ts";

/** Returns the text of a recorded user message as the executor sent it. */
export const userMessageText = (item: typeof UserMessageItem.Type): string =>
  item.content
    .filter(Schema.is(UserTextInput))
    .map(({ text }) => text)
    .join("");

/** Returns the retry message followed by its details in parentheses. */
export const providerRetryMessage = (error: (typeof ErrorNotification.Type)["error"]): string => {
  const message = error.message.trim() || "Codex is retrying its model provider";
  const details = error.additionalDetails?.trim() ?? "";
  return details === "" ? message : `${message} (${details})`;
};

/** Decodes a required response. Fails with `SessionOperationError` for `operation` if the data is malformed. */
export const decodeResponse = <S extends Schema.Top>(
  schema: S,
  operation: SessionOperationError["operation"],
  client: CodexClient,
  label: string,
  value: Schema.Json,
): Effect.Effect<S["Type"], SessionOperationError, S["DecodingServices"]> =>
  Schema.decodeEffect(schema)(value).pipe(
    Effect.mapError((cause) =>
      operationError(operation, client, `Codex returned an invalid ${label}`, cause),
    ),
  );

/** Decodes a notification payload; if it does not decode, logs a warning and returns `None`. */
export const decodeNotification = <S extends Schema.Top>(
  schema: S,
  label: string,
  sessionId: AgentSessionId,
  value: Schema.Json,
): Effect.Effect<Option.Option<S["Type"]>, never, S["DecodingServices"]> =>
  Schema.decodeEffect(schema)(value).pipe(
    Effect.asSome,
    Effect.catch((cause) =>
      Effect.logWarning(`Skipping an undecodable Codex ${label}`, { cause, sessionId }).pipe(
        Effect.as(Option.none()),
      ),
    ),
  );

/**
 * Decodes a thread item whose kind the caller has checked. If it does not decode, logs a warning
 * annotated with its `itemType` and returns `None`.
 */
export const decodeItem = <S extends Schema.Top>(
  schema: S,
  label: string,
  sessionId: AgentSessionId,
  item: Schema.Json & { readonly type: string },
): Effect.Effect<Option.Option<S["Type"]>, never, S["DecodingServices"]> =>
  decodeNotification(schema, label, sessionId, item).pipe(
    Effect.annotateLogs({ itemType: item.type }),
  );

const ToolKindItem = Schema.Struct({ type: ToolItem.fields.type });
/** Matches a thread item of the agent message kind, whether or not it decodes. */
export const AgentMessageKindItem = Schema.Struct({ type: AgentMessageItem.fields.type });
/** Matches a thread item of the user message kind, whether or not it decodes. */
export const UserMessageKindItem = Schema.Struct({ type: UserMessageItem.fields.type });
const MessageKindItem = Schema.Union([AgentMessageKindItem, UserMessageKindItem]);
const ItemKind = Schema.Struct({ type: Schema.String });

/**
 * Decodes a thread item as a tool item, or returns `None` when its type names no tool kind. If an
 * item of a tool kind does not decode, logs a warning and returns `None`.
 */
export const decodeToolItem = (
  sessionId: AgentSessionId,
  item: Schema.Json,
): Effect.Effect<Option.Option<typeof ToolItem.Type>> =>
  Schema.is(ToolKindItem)(item)
    ? decodeItem(ToolItem, "tool item", sessionId, item)
    : Effect.succeedNone;

/**
 * Decodes a notified thread item as a tool item, like `decodeToolItem`. Returns `None` for message
 * items: each notification handler decodes the message kind it handles before calling this, and
 * the other message kind has no event there. Logs every other skipped kind at Info.
 */
export const decodeNotifiedToolItem = (
  sessionId: AgentSessionId,
  item: Schema.Json,
): Effect.Effect<Option.Option<typeof ToolItem.Type>> =>
  Schema.is(ToolKindItem)(item)
    ? decodeItem(ToolItem, "tool item", sessionId, item)
    : Schema.is(MessageKindItem)(item)
      ? Effect.succeedNone
      : Effect.logInfo("Skipping a Codex item without a transcript event", { sessionId }).pipe(
          Effect.annotateLogs({ itemType: Schema.is(ItemKind)(item) ? item.type : undefined }),
          Effect.as(Option.none()),
        );

/** Returns the transcript tool name for a Codex tool item. */
export const toolName = (item: typeof ToolItem.Type): string => {
  switch (item.type) {
    case "commandExecution":
      return "command";
    case "fileChange":
      return "file_change";
    case "mcpToolCall":
      return "mcp_tool";
    case "dynamicToolCall":
      return "dynamic_tool";
    case "webSearch":
      return "web_search";
    case "imageView":
      return "image_view";
    case "imageGeneration":
      return "image_generation";
  }
};

/** Converts a rate-limit window, with reset timestamps in UTC and absent values as `None`. */
export const rateLimitWindow = (window: typeof RateLimitWindow.Type): CoreRateLimitWindow =>
  CoreRateLimitWindow.make({
    usedPercent: window.usedPercent,
    windowDurationMinutes: Option.fromNullishOr(window.windowDurationMins),
    resetsAt: Option.fromNullishOr(window.resetsAt).pipe(Option.map(DateTime.fromEpochSeconds)),
  });

/** Converts the account's rate-limit snapshot from `account/rateLimits/updated`. */
export const rateLimitsSnapshot = (
  snapshot: (typeof RateLimitsUpdated.Type)["rateLimits"],
): RateLimitsSnapshot =>
  RateLimitsSnapshot.make({
    limitId: Option.fromNullishOr(snapshot.limitId),
    limitName: Option.fromNullishOr(snapshot.limitName),
    primary: Option.fromNullishOr(snapshot.primary).pipe(Option.map(rateLimitWindow)),
    secondary: Option.fromNullishOr(snapshot.secondary).pipe(Option.map(rateLimitWindow)),
  });

/**
 * Returns the latest reset time among the snapshot's used-up windows, or `None` if no window is
 * used up or a used-up window has no reset time.
 */
export const exhaustedUntil = (snapshot: RateLimitsSnapshot): Option.Option<DateTime.Utc> => {
  const exhausted = [snapshot.primary, snapshot.secondary].flatMap((window) =>
    Option.isSome(window) && window.value.usedPercent >= 100 ? [window.value.resetsAt] : [],
  );
  return Option.all(exhausted).pipe(
    Option.flatMap(([first, ...rest]) =>
      first === undefined ? Option.none() : Option.some(rest.reduce(DateTime.max, first)),
    ),
  );
};

const decodeHttpStatus = Schema.decodeUnknownOption(
  Schema.Struct({ httpStatusCode: Schema.NullOr(Schema.Finite) }),
);

// Codex also reports a billing quota, a plan without Codex, and a workspace that is out of
// credits or at its spend cap as a usage limit; none resets until someone changes the account.
const permanentLimit =
  /^(?:Quota exceeded\b|To use Codex with your ChatGPT plan\b|Your workspace is out of credits\b|You hit your spend cap\b)/u;

/**
 * Classifies the final turn error, preferring Codex's error code to message matching. A usage or
 * rate limit, including a final HTTP 429 after Codex's own retries, is a capacity refusal that
 * resets when the latest rate-limit snapshot's used-up windows reset, if `rateLimits` has them.
 */
export const turnFailure = (
  sessionId: AgentSessionId,
  error: (typeof TurnCompleted.Type)["turn"]["error"],
  message: string,
  rateLimits: Option.Option<RateLimitsSnapshot>,
): AgentResultError | AgentCapacityError => {
  const code = error?.codexErrorInfo;
  if (
    code === undefined ||
    code === null ||
    (Schema.is(Schema.String)(code) && isCodexErrorCode(code, "other"))
  )
    return harnessFailure(Option.some(sessionId), message);
  if (
    Schema.is(Schema.String)(code) &&
    (isCodexErrorCode(code, "usageLimitExceeded") || isCodexErrorCode(code, "rateLimitExceeded"))
  )
    return permanentLimit.test(message)
      ? AgentResultError.make({ sessionId: Option.some(sessionId), message })
      : AgentCapacityError.make({
          sessionId: Option.some(sessionId),
          message,
          resetsAt: Option.flatMap(rateLimits, exhaustedUntil),
        });
  if (Schema.is(Schema.String)(code))
    return isCodexErrorCode(code, "serverOverloaded")
      ? AgentCapacityError.make({ sessionId: Option.some(sessionId), message })
      : AgentResultError.make({ sessionId: Option.some(sessionId), message });
  const statuses = Object.values(code).flatMap((detail) =>
    Option.match(decodeHttpStatus(detail), {
      onNone: () => [],
      onSome: ({ httpStatusCode }) => (httpStatusCode === null ? [] : [httpStatusCode]),
    }),
  );
  // Codex reports an exhausted API-key quota as `usageLimitExceeded`, so a final HTTP 429 is a
  // rate limit.
  if (statuses.includes(429) && !permanentLimit.test(message))
    return AgentCapacityError.make({
      sessionId: Option.some(sessionId),
      message,
      resetsAt: Option.flatMap(rateLimits, exhaustedUntil),
    });
  const overloaded = statuses.some(
    (status) =>
      status === 529 ||
      (status === 503 &&
        /\bretry(?:[- ]after)?\b|\btry again\b/iu.test(
          message + " " + (error?.additionalDetails ?? ""),
        )),
  );
  return overloaded
    ? AgentCapacityError.make({ sessionId: Option.some(sessionId), message })
    : AgentResultError.make({ sessionId: Option.some(sessionId), message });
};

/**
 * Classifies the failed turn `turn` with `turnFailure`, and logs a capacity refusal or usage
 * limit with its reset time. A session and a completion both end a failed turn here.
 */
export const failedTurn = Effect.fn("CodexRuntime.failedTurn")(function* (
  sessionId: AgentSessionId,
  turn: (typeof TurnCompleted.Type)["turn"],
  message: string,
  rateLimits: Option.Option<RateLimitsSnapshot>,
) {
  const failure = turnFailure(sessionId, turn.error, message, rateLimits);
  if (Schema.is(AgentCapacityError)(failure))
    yield* Effect.logWarning("Codex turn ended on a provider capacity refusal or usage limit", {
      sessionId,
      turnId: turn.id,
      codexErrorInfo: turn.error?.codexErrorInfo,
      resetsAt: Option.getOrUndefined(Option.map(failure.resetsAt, DateTime.formatIso)),
    });
  return failure;
});

/** The server notification methods with no session event equivalent; they are only logged. */
export const DIAGNOSTIC_METHODS: ReadonlySet<string> = new Set([
  "error",
  "warning",
  "configWarning",
  "deprecationNotice",
  "guardianWarning",
  "model/rerouted",
]);

/** Decodes a provider error notification, which reports whether Codex retries. */
export const decodeRetry = Schema.decodeUnknownOption(ErrorNotification);
