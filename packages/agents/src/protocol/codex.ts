import { EndpointName, HarnessSessionId } from "@usine/core/agent/session";
import { Schema } from "effect";
import { UsageCount } from "./count.ts";

/**
 * The Codex app-server wire types: the request types that usine sends, copied from
 * `@pwrdrvr/codex-app-server-protocol@0.164.0` (codex-cli 0.164.0) because that package resolves
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

export const ModelListParams = Schema.Struct({
  cursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
  limit: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  includeHidden: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
});
export type ModelListParams = typeof ModelListParams.Type;

export interface GetAccountParams {
  readonly refreshToken?: boolean;
}

const ApprovalPolicy = Schema.optionalKey(
  Schema.NullOr(Schema.Literals(["never", "on-request", "untrusted"])),
);
const Sandbox = Schema.optionalKey(
  Schema.NullOr(Schema.Literals(["read-only", "workspace-write", "danger-full-access"])),
);

export const ThreadStartParams = Schema.Struct({
  model: Schema.optionalKey(Schema.NullOr(Schema.String)),
  allowProviderModelFallback: Schema.optionalKey(Schema.Boolean),
  cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
  approvalPolicy: ApprovalPolicy,
  sandbox: Sandbox,
  serviceName: Schema.optionalKey(Schema.NullOr(Schema.String)),
  ephemeral: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
});
export type ThreadStartParams = typeof ThreadStartParams.Type;

export const ThreadResumeParams = Schema.Struct({
  threadId: Schema.String,
  model: Schema.optionalKey(Schema.NullOr(Schema.String)),
  cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
  approvalPolicy: ApprovalPolicy,
  sandbox: Sandbox,
  excludeTurns: Schema.optionalKey(Schema.Boolean),
});
export type ThreadResumeParams = typeof ThreadResumeParams.Type;

const TextInput = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  text_elements: Schema.Array(Schema.Never),
});

export const TurnStartParams = Schema.Struct({
  threadId: Schema.String,
  input: Schema.Array(TextInput),
  cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
  approvalPolicy: ApprovalPolicy,
  sandboxPolicy: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ type: Schema.Literal("dangerFullAccess") })),
  ),
  effort: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type TurnStartParams = typeof TurnStartParams.Type;

export const TurnSteerParams = Schema.Struct({
  threadId: Schema.String,
  expectedTurnId: Schema.String,
  input: Schema.Array(TextInput),
});
export type TurnSteerParams = typeof TurnSteerParams.Type;

export const TurnInterruptParams = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
});
export type TurnInterruptParams = typeof TurnInterruptParams.Type;

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
  modelProvider: EndpointName,
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
  id: Schema.NonEmptyString,
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
/** Saved turn state needed to reattach an active turn without starting another one. */
export const ThreadResumeResponse = Schema.Struct({
  modelProvider: EndpointName,
  thread: Schema.Struct({
    id: HarnessSessionId,
    turns: Schema.Array(
      Schema.Struct({
        id: Schema.NonEmptyString,
        status: Schema.Literals(["completed", "interrupted", "failed", "inProgress"] as const),
        items: Schema.Array(
          Schema.Union([ToolItem, AgentMessageItem, Schema.Struct({ type: Schema.String })]),
        ),
      }),
    ),
  }),
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
          Schema.NullOr(
            Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Unknown)]),
          ),
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
  usedPercent: Schema.Finite,
  windowDurationMins: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  resetsAt: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
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
