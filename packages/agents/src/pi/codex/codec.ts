import { AgentSessionId, RateLimitWindow as CoreRateLimitWindow } from "@usine/core/agent/session";
import { DateTime, Effect, Option, Schema } from "effect";
import {
  type ErrorNotification,
  type ModelListParams,
  type RateLimitWindow,
  type ThreadStartParams,
  type ToolItem,
  type TurnInterruptParams,
  type TurnCompleted,
  type TurnStartParams,
  type TurnSteerParams,
  type UserMessageItem,
  UserTextInput,
} from "../../protocol/codex.ts";
import {
  AgentCapacityError,
  AgentResultError,
  harnessFailure,
  SessionOperationError,
} from "../../runtime.ts";
import { type CodexClient, operationError } from "./app-server.ts";

type CodexRequestPayload =
  | ModelListParams
  | ThreadStartParams
  | TurnStartParams
  | TurnSteerParams
  | TurnInterruptParams;

/** Returns typed Codex request parameters as JSON for the app-server transport. */
export const json = (value: CodexRequestPayload): Schema.Json =>
  Schema.decodeUnknownSync(Schema.Json)(JSON.parse(JSON.stringify(value)));

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
  Schema.decodeUnknownEffect(schema)(value).pipe(
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
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.map(Option.some),
    Effect.catch((cause) =>
      Effect.logWarning(`Skipping an undecodable Codex ${label}`, { cause, sessionId }).pipe(
        Effect.as(Option.none()),
      ),
    ),
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
  new CoreRateLimitWindow({
    usedPercent: window.usedPercent,
    windowDurationMinutes: Option.fromNullishOr(window.windowDurationMins),
    resetsAt: Option.fromNullishOr(window.resetsAt).pipe(Option.map(DateTime.fromEpochSeconds)),
  });

const decodeHttpStatus = Schema.decodeUnknownOption(
  Schema.Struct({ httpStatusCode: Schema.NullOr(Schema.Number) }),
);

/** Classifies the final turn error, preferring Codex's error code to message matching. */
export const turnFailure = (
  sessionId: AgentSessionId,
  error: (typeof TurnCompleted.Type)["turn"]["error"],
  message: string,
): AgentResultError | AgentCapacityError => {
  const code = error?.codexErrorInfo;
  if (code === undefined || code === null || code === "other")
    return harnessFailure(Option.some(sessionId), message);
  const capacity = Schema.is(Schema.String)(code)
    ? code === "serverOverloaded"
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
    ? new AgentCapacityError({ sessionId: Option.some(sessionId), message })
    : new AgentResultError({ sessionId: Option.some(sessionId), message });
};
