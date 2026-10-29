import { HarnessSessionId } from "@usine/core/agent/session";
import { Schema } from "effect";
import { UsageCount } from "./count.ts";

/**
 * The Codex app-server wire types: the request types that usine sends, copied from
 * `@pwrdrvr/codex-app-server-protocol@0.159.2` (codex-cli 0.159.2) because that package resolves
 * only under bundler module resolution, and the decoders for the responses and notifications that
 * usine reads. `protocol-conformance/check.ts` fails `pnpm check` if either drifts from the
 * package; it compiles this module without Node types, so nothing here imports a Node module.
 */
export interface InitializeParams {
  readonly clientInfo: {
    readonly name: string;
    readonly title: string | null;
    readonly version: string;
  };
  readonly capabilities: null;
}

export interface ModelListParams {
  readonly cursor?: string | null;
  readonly limit?: number | null;
  readonly includeHidden?: boolean | null;
}

export interface GetAccountParams {
  readonly refreshToken?: boolean;
}

export interface ThreadStartParams {
  readonly model?: string | null;
  readonly allowProviderModelFallback?: boolean;
  readonly cwd?: string | null;
  readonly approvalPolicy?: "never" | "on-request" | "untrusted" | null;
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access" | null;
  readonly serviceName?: string | null;
  readonly ephemeral?: boolean | null;
}

interface TextInput {
  readonly type: "text";
  readonly text: string;
  readonly text_elements: ReadonlyArray<never>;
}

export interface TurnStartParams {
  readonly threadId: string;
  readonly input: ReadonlyArray<TextInput>;
  readonly cwd?: string | null;
  readonly approvalPolicy?: "never" | "on-request" | "untrusted" | null;
  readonly sandboxPolicy?: { readonly type: "dangerFullAccess" } | null;
  readonly effort?: string | null;
}

export interface TurnSteerParams {
  readonly threadId: string;
  readonly expectedTurnId: string;
  readonly input: ReadonlyArray<TextInput>;
}

export interface TurnInterruptParams {
  readonly threadId: string;
  readonly turnId: string;
}

export const AccountResponse = Schema.Struct({
  account: Schema.NullOr(
    Schema.Struct({
      type: Schema.String,
      email: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
  requiresOpenaiAuth: Schema.Boolean,
});
export const AccountUpdated = Schema.Struct({ authMode: Schema.NullOr(Schema.String) });

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
/** The text part of a user message. */
export const UserTextInput = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
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
        codexErrorInfo: Schema.optionalKey(
          Schema.NullOr(Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Json)])),
        ),
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

// Upstream sends partial updates where any field can be absent, so only `usedPercent` is required.
export const RateLimitWindow = Schema.Struct({
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

/**
 * The Codex thread token usage, cumulative across turns; `inputTokens` includes cache reads and
 * cache writes.
 */
export const CodexTokenUsage = Schema.Struct({
  threadId: Schema.NonEmptyString,
  tokenUsage: Schema.Struct({
    total: Schema.Struct({
      inputTokens: UsageCount,
      cachedInputTokens: UsageCount,
      cacheWriteInputTokens: UsageCount,
      outputTokens: UsageCount,
    }),
  }),
});
export type CodexTokenUsage = typeof CodexTokenUsage.Type;
