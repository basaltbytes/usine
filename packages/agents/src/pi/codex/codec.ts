import { AgentSessionId, RateLimitWindow as CoreRateLimitWindow } from "@usine/core/agent/session";
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

/** Encodes typed Codex request parameters for the app-server JSON transport. */
export const json = (value: CodexRequestPayload): Schema.Json =>
  Schema.decodeUnknownSync(Schema.Json)(JSON.parse(JSON.stringify(value)));

/** Model catalog page used to validate the requested model and reasoning effort. */
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
/** Thread identity and effective model returned when a child conversation opens. */
export const ThreadStartResponse = Schema.Struct({
  thread: Schema.Struct({ id: Schema.NonEmptyString }),
  model: Schema.NonEmptyString,
  instructionSources: Schema.Array(Schema.String),
});
/** Turn identity required to address guidance and interruption. */
export const TurnStartResponse = Schema.Struct({
  turn: Schema.Struct({ id: Schema.NonEmptyString }),
});
/** Routes a vendor item to its thread and turn while preserving its JSON details. */
export const ItemNotification = Schema.Struct({
  item: Schema.Json,
  threadId: Schema.String,
  turnId: Schema.String,
});
/** Completed assistant prose; phase distinguishes a final answer from commentary. */
export const AgentMessageItem = Schema.Struct({
  type: Schema.Literal("agentMessage"),
  id: Schema.NonEmptyString,
  text: Schema.String,
  phase: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
/** Recognized tool activity with the fields needed to pair starts and results. */
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
/** Turn outcome used to resume a held conversation or report a session failure. */
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
// Upstream sends this notification as a sparse rolling update: any account
// field may be absent, so only the load figure is required.
const RateLimitWindow = Schema.Struct({
  usedPercent: Schema.Number,
  windowDurationMins: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  resetsAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
/** Sparse account usage update; omitted windows remain absent in the normalized snapshot. */
export const RateLimitsUpdated = Schema.Struct({
  rateLimits: Schema.Struct({
    limitId: Schema.optionalKey(Schema.NullOr(Schema.String)),
    limitName: Schema.optionalKey(Schema.NullOr(Schema.String)),
    primary: Schema.optionalKey(Schema.NullOr(RateLimitWindow)),
    secondary: Schema.optionalKey(Schema.NullOr(RateLimitWindow)),
  }),
});

/** Decodes a required response, attributing malformed data to the client operation and response label. */
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

/** Decodes one notification payload; an undecodable payload is logged and skipped, never fatal. */
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

/** Maps a recognized vendor tool kind to the stable transcript tool name. */
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

/** Normalizes an account window, converting reset timestamps to UTC and absent values to Options. */
export const rateLimitWindow = (window: typeof RateLimitWindow.Type): CoreRateLimitWindow =>
  new CoreRateLimitWindow({
    usedPercent: window.usedPercent,
    windowDurationMinutes: Option.fromNullishOr(window.windowDurationMins),
    resetsAt: Option.fromNullishOr(window.resetsAt).pipe(Option.map(DateTime.fromEpochSeconds)),
  });
