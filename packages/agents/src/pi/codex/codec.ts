import {
  HarnessSessionId,
  AgentSessionId,
  RateLimitWindow as CoreRateLimitWindow,
} from "@usine/core/agent/session";
import { DateTime, Effect, Option, Schema } from "effect";
import type {
  ModelListParams,
  ThreadStartParams,
  TurnInterruptParams,
  TurnStartParams,
  TurnSteerParams,
} from "../../protocol/codex.ts";
import { SessionOperationError } from "../../runtime.ts";
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

/** The model catalog page, used to validate the requested model and reasoning effort. */
export const ModelListResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      model: Schema.String,
      supportedReasoningEfforts: Schema.optionalKey(
        Schema.Array(Schema.Struct({ reasoningEffort: Schema.String })),
      ),
    }),
  ),
  nextCursor: Schema.NullOr(Schema.String),
});
/** The thread ID and effective model returned when a child thread starts. */
export const ThreadStartResponse = Schema.Struct({
  thread: Schema.Struct({ id: HarnessSessionId }),
  model: Schema.NonEmptyString,
  instructionSources: Schema.Array(Schema.String),
});
/** The turn ID, needed to steer or interrupt the turn. */
export const TurnStartResponse = Schema.Struct({
  turn: Schema.Struct({ id: Schema.NonEmptyString }),
});
/** An item notification with its thread and turn IDs; `item` is kept as JSON. */
export const ItemNotification = Schema.Struct({
  item: Schema.Json,
  threadId: Schema.String,
  turnId: Schema.String,
});
/** A user message recorded in the thread: a turn's input, or steered input once the running turn reads it. */
export const UserMessageItem = Schema.Struct({
  type: Schema.Literal("userMessage"),
  content: Schema.Array(Schema.Json),
});
const UserTextInput = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
/** Returns the text of a recorded user message as the executor sent it. */
export const userMessageText = (item: typeof UserMessageItem.Type): string =>
  item.content
    .filter(Schema.is(UserTextInput))
    .map(({ text }) => text)
    .join("");
/** A completed assistant message; `phase` distinguishes a final answer from commentary. */
export const AgentMessageItem = Schema.Struct({
  type: Schema.Literal("agentMessage"),
  id: Schema.NonEmptyString,
  text: Schema.String,
  phase: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
/** A recognized tool item, with the fields needed to match starts and results. */
export const ToolItem = Schema.Struct({
  type: Schema.Literals([
    "commandExecution",
    "fileChange",
    "mcpToolCall",
    "dynamicToolCall",
    "webSearch",
    "imageView",
    "imageGeneration",
  ] as const),
  id: Schema.NonEmptyString,
  status: Schema.optionalKey(Schema.String),
  success: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
});
/** The outcome of a turn, used to resume a conversation on Hold or report a session failure. */
export const TurnCompleted = Schema.Struct({
  turn: Schema.Struct({
    id: Schema.String,
    status: Schema.Literals(["completed", "interrupted", "failed", "inProgress"] as const),
    error: Schema.NullOr(
      Schema.Struct({
        message: Schema.String,
        additionalDetails: Schema.NullOr(Schema.String),
      }),
    ),
  }),
});
/** A turn error from the app server; if `willRetry` is set, the model provider request is retried, for example `Reconnecting... 2/5`. */
export const ErrorNotification = Schema.Struct({
  error: Schema.Struct({
    message: Schema.String,
    additionalDetails: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
  willRetry: Schema.Boolean,
  turnId: Schema.String,
});
/** Any notification for one turn, for example an item or a streaming delta. */
export const TurnActivity = Schema.Struct({ turnId: Schema.String });

/** Returns the retry message followed by its details in parentheses. */
export const providerRetryMessage = (error: (typeof ErrorNotification.Type)["error"]): string => {
  const message = error.message.trim() || "Codex is retrying its model provider";
  const details = error.additionalDetails?.trim() ?? "";
  return details === "" ? message : `${message} (${details})`;
};
// Upstream sends partial updates where any field can be absent, so only `usedPercent` is required.
const RateLimitWindow = Schema.Struct({
  usedPercent: Schema.Number,
  windowDurationMins: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  resetsAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
/** A partial account usage update; omitted windows are also absent in the normalized snapshot. */
export const RateLimitsUpdated = Schema.Struct({
  rateLimits: Schema.Struct({
    limitId: Schema.optionalKey(Schema.NullOr(Schema.String)),
    limitName: Schema.optionalKey(Schema.NullOr(Schema.String)),
    primary: Schema.optionalKey(Schema.NullOr(RateLimitWindow)),
    secondary: Schema.optionalKey(Schema.NullOr(RateLimitWindow)),
  }),
});

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
