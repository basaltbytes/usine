import { AgentSessionId, RateLimitWindow as CoreRateLimitWindow } from "@usine/core/agent/session";
import { DateTime, Effect, Option, Schema } from "effect";
import {
  AgentMessageItem,
  ErrorNotification,
  isCodexErrorCode,
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

const decodeHttpStatus = Schema.decodeUnknownOption(
  Schema.Struct({ httpStatusCode: Schema.NullOr(Schema.Finite) }),
);

/** Classifies the final turn error, preferring Codex's error code to message matching. */
export const turnFailure = (
  sessionId: AgentSessionId,
  error: (typeof TurnCompleted.Type)["turn"]["error"],
  message: string,
): AgentResultError | AgentCapacityError => {
  const code = error?.codexErrorInfo;
  if (
    code === undefined ||
    code === null ||
    (Schema.is(Schema.String)(code) && isCodexErrorCode(code, "other"))
  )
    return harnessFailure(Option.some(sessionId), message);
  const capacity = Schema.is(Schema.String)(code)
    ? isCodexErrorCode(code, "serverOverloaded")
    : Object.values(code).some((detail) =>
        Option.exists(
          decodeHttpStatus(detail),
          ({ httpStatusCode }) =>
            httpStatusCode === 529 ||
            (httpStatusCode === 503 &&
              /\bretry(?:[- ]after)?\b|\btry again\b/iu.test(
                message + " " + (error?.additionalDetails ?? ""),
              )),
        ),
      );
  return capacity
    ? AgentCapacityError.make({ sessionId: Option.some(sessionId), message })
    : AgentResultError.make({ sessionId: Option.some(sessionId), message });
};

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
