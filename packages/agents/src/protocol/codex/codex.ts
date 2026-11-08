import { EndpointName, HarnessSessionId } from "@usine/core/agent/session";
import { Schema } from "effect";
import { UsageCount } from "../count.ts";
import {
  AccountRateLimitsUpdatedNotification,
  AccountUpdatedNotification,
  AgentMessageDeltaNotification,
  AgentMessageThreadItem,
  AuthModeValues,
  ChatgptAccount,
  CommandExecutionThreadItem,
  CommandExecutionStatusValues,
  DynamicToolCallThreadItem,
  ErrorNotification as GeneratedErrorNotification,
  FileChangeThreadItem,
  GetAccountResponse,
  ImageGenerationThreadItem,
  ImageViewThreadItem,
  ItemStartedNotification,
  LegacyAppPathString,
  McpToolCallThreadItem,
  MessagePhaseValues,
  Model,
  ModelListResponse as GeneratedModelListResponse,
  TextUserInput,
  ThreadResumeResponse as GeneratedThreadResumeResponse,
  ThreadStartResponse as GeneratedThreadStartResponse,
  ThreadTokenUsageUpdatedNotification,
  TurnCompletedNotification,
  TurnError,
  TurnStartResponse as GeneratedTurnStartResponse,
  TurnStatusValues,
  UserMessageThreadItem,
  WebSearchThreadItem,
} from "./generated.ts";

const matchesKnownValue =
  <Values extends ReadonlyArray<string>>(_values: Values) =>
  (value: string | null | undefined, expected: Values[number]) =>
    value === expected;

export const isTurnStatus = matchesKnownValue(TurnStatusValues);
export const isToolStatus = matchesKnownValue(CommandExecutionStatusValues);
export const isMessagePhase = matchesKnownValue(MessagePhaseValues);
export const isAuthMode = matchesKnownValue(AuthModeValues);

/** Request subsets and response selections for usine's Codex adapter. */
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

export const AccountResponse = GetAccountResponse.mapFields(({ requiresOpenaiAuth }) => ({
  requiresOpenaiAuth,
  account: Schema.NullOr(
    Schema.Struct({
      type: Schema.String,
      email: Schema.optionalKey(ChatgptAccount.fields.email),
    }),
  ),
}));
export const AccountUpdated = AccountUpdatedNotification.mapFields(({ authMode }) => ({
  authMode,
}));

/** The model catalog fields used to validate the model and reasoning effort. */
export const ModelListResponse = GeneratedModelListResponse.mapFields(({ nextCursor }) => ({
  nextCursor: Schema.requiredKey(nextCursor),
  data: Schema.Array(
    Model.mapFields(({ id, model, supportedReasoningEfforts }) => ({
      id,
      model,
      supportedReasoningEfforts: Schema.optionalKey(
        Schema.Array(
          supportedReasoningEfforts.value.mapFields(({ reasoningEffort }) => ({ reasoningEffort })),
        ),
      ),
    })),
  ),
}));
export const ThreadStartResponse = GeneratedThreadStartResponse.mapFields(({ thread }) => ({
  modelProvider: EndpointName,
  thread: thread.mapFields(() => ({ id: HarnessSessionId })),
  model: Schema.NonEmptyString,
  instructionSources: Schema.Array(LegacyAppPathString),
}));
export const TurnStartResponse = GeneratedTurnStartResponse.mapFields(({ turn }) => ({
  turn: turn.mapFields(() => ({ id: Schema.NonEmptyString })),
}));
/** Item payloads are decoded separately so unrecognized item kinds can be ignored. */
export const ItemNotification = ItemStartedNotification.mapFields(({ threadId, turnId }) => ({
  item: Schema.Json,
  threadId,
  turnId,
}));
export const UserMessageItem = UserMessageThreadItem.mapFields(({ type }) => ({
  id: Schema.NonEmptyString,
  type,
  content: Schema.Array(Schema.Json),
}));
export const UserTextInput = TextUserInput.mapFields(({ type, text }) => ({ type, text }));
export const AgentMessageItem = AgentMessageThreadItem.mapFields(({ type, text, phase }) => ({
  type,
  id: Schema.NonEmptyString,
  text,
  phase,
}));
/** Tool kinds are closed because toolName branches on each recognized kind. */
export const ToolItem = Schema.Struct({
  type: Schema.Union([
    CommandExecutionThreadItem.fields.type,
    FileChangeThreadItem.fields.type,
    McpToolCallThreadItem.fields.type,
    DynamicToolCallThreadItem.fields.type,
    WebSearchThreadItem.fields.type,
    ImageViewThreadItem.fields.type,
    ImageGenerationThreadItem.members[0].fields.type,
  ]),
  id: Schema.NonEmptyString,
  status: Schema.optionalKey(CommandExecutionThreadItem.fields.status),
  success: Schema.optionalKey(DynamicToolCallThreadItem.fields.success),
});
export const ThreadResumeResponse = GeneratedThreadResumeResponse.mapFields(({ thread }) => ({
  modelProvider: EndpointName,
  thread: thread.mapFields(({ turns }) => ({
    id: HarnessSessionId,
    turns: Schema.Array(
      turns.value.mapFields(({ status }) => ({
        id: Schema.NonEmptyString,
        status,
        items: Schema.Array(
          Schema.Union([ToolItem, AgentMessageItem, Schema.Struct({ type: Schema.String })]),
        ),
      })),
    ),
  })),
}));
export const TurnCompleted = TurnCompletedNotification.mapFields(({ turn }) => ({
  turn: turn.mapFields(({ id, status }) => ({
    id,
    status,
    error: Schema.NullOr(
      TurnError.mapFields(({ message, additionalDetails }) => ({
        message,
        additionalDetails,
        // Error objects can gain new variants; turnFailure classifies only known capacity errors.
        codexErrorInfo: Schema.optionalKey(
          Schema.NullOr(
            Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Unknown)]),
          ),
        ),
      })),
    ),
  })),
}));
export const ErrorNotification = GeneratedErrorNotification.mapFields(
  ({ error, willRetry, turnId }) => ({
    error: error.mapFields(({ message, additionalDetails }) => ({ message, additionalDetails })),
    willRetry,
    turnId,
  }),
);
export const TurnActivity = AgentMessageDeltaNotification.mapFields(({ turnId }) => ({ turnId }));
export { RateLimitWindow } from "./generated.ts";
export const RateLimitsUpdated = AccountRateLimitsUpdatedNotification.mapFields(
  ({ rateLimits }) => ({
    rateLimits: rateLimits.mapFields(({ limitId, limitName, primary, secondary }) => ({
      limitId,
      limitName,
      primary,
      secondary,
    })),
  }),
);
/** Cumulative usage includes cache reads and writes in inputTokens. */
export const CodexTokenUsage = ThreadTokenUsageUpdatedNotification.mapFields(({ tokenUsage }) => ({
  threadId: Schema.NonEmptyString,
  tokenUsage: tokenUsage.mapFields(({ total }) => ({
    total: total.mapFields(() => ({
      inputTokens: UsageCount,
      cachedInputTokens: UsageCount,
      cacheWriteInputTokens: UsageCount,
      outputTokens: UsageCount,
    })),
  })),
}));
export type CodexTokenUsage = typeof CodexTokenUsage.Type;
