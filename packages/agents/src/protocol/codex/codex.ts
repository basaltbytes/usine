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
  CodexErrorInfoValues,
  CommandExecutionThreadItem,
  CommandExecutionStatusValues,
  DynamicToolCallStatusValues,
  DynamicToolCallThreadItem,
  ErrorNotification as GeneratedErrorNotification,
  FileChangeThreadItem,
  GetAccountResponse,
  ImageGenerationThreadItem,
  ImageViewThreadItem,
  ItemStartedNotification,
  McpToolCallStatusValues,
  McpToolCallThreadItem,
  MessagePhaseValues,
  ModelListResponse as GeneratedModelListResponse,
  PatchApplyStatusValues,
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

type CommonValue<Lists extends ReadonlyArray<ReadonlyArray<string>>> = {
  readonly [Index in keyof Lists]: (value: Lists[Index][number]) => void;
}[number] extends (value: infer Value) => void
  ? Value
  : never;

/**
 * Returns a comparison whose expected value must be a member of every list. The comparison's
 * `lists` property holds the lists in argument order.
 */
const matchesKnownValue = <Lists extends ReadonlyArray<ReadonlyArray<string>>>(...lists: Lists) =>
  Object.assign(
    (value: string | null | undefined, expected: CommonValue<Lists>) => value === expected,
    { lists },
  );

interface ReplacedField<Replacement extends Schema.Top> {
  readonly Encoded: Replacement["Encoded"];
  readonly "~encoded.optionality": Replacement["~encoded.optionality"];
}

/**
 * Returns `replacement` for a generated field, or for the same field of each listed schema. Fails
 * to compile unless `replacement` decodes every encoded value of each field and preserves its key
 * optionality.
 */
export const replaces = <Replacement extends Schema.Top>(
  _field: ReplacedField<Replacement> | ReadonlyArray<ReplacedField<Replacement>>,
  replacement: Replacement,
): Replacement => replacement;

export const isTurnStatus = matchesKnownValue(TurnStatusValues);
/**
 * Compares a tool item status. Expected values must be members of the status lists of command,
 * file-change, MCP, and dynamic tool items. Image generation items report a free-form status that
 * upstream doesn't list.
 */
export const isToolStatus = matchesKnownValue(
  CommandExecutionStatusValues,
  PatchApplyStatusValues,
  McpToolCallStatusValues,
  DynamicToolCallStatusValues,
);
/** Compares a status of command and file-change items, the tool kinds that require approval. */
export const isApprovalToolStatus = matchesKnownValue(
  CommandExecutionStatusValues,
  PatchApplyStatusValues,
);
export const isMessagePhase = matchesKnownValue(MessagePhaseValues);
export const isAuthMode = matchesKnownValue(AuthModeValues);
export const isCodexErrorCode = matchesKnownValue(CodexErrorInfoValues);

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

export const AccountResponse = GetAccountResponse.mapFields(({ requiresOpenaiAuth, account }) => ({
  requiresOpenaiAuth,
  account: replaces(
    account,
    Schema.optionalKey(
      Schema.NullOr(
        Schema.Struct({
          type: Schema.String,
          email: Schema.optionalKey(ChatgptAccount.fields.email),
        }),
      ),
    ),
  ),
}));
export const AccountUpdated = AccountUpdatedNotification.mapFields(({ authMode }) => ({
  authMode,
}));

/** The model catalog fields used to validate the model and reasoning effort. */
export const ModelListResponse = GeneratedModelListResponse.mapFields(({ nextCursor, data }) => ({
  nextCursor,
  data: Schema.Array(
    data.value.mapFields(({ id, model, supportedReasoningEfforts }) => ({
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
export const ThreadStartResponse = GeneratedThreadStartResponse.mapFields(
  ({ modelProvider, thread, model }) => ({
    modelProvider: replaces(modelProvider, EndpointName),
    thread: thread.mapFields(({ id }) => ({ id: replaces(id, HarnessSessionId) })),
    model: replaces(model, Schema.NonEmptyString),
  }),
);
export const TurnStartResponse = GeneratedTurnStartResponse.mapFields(({ turn }) => ({
  turn: turn.mapFields(({ id }) => ({ id: replaces(id, Schema.NonEmptyString) })),
}));
/** Item payloads are decoded separately so unrecognized item kinds can be ignored. */
export const ItemNotification = ItemStartedNotification.mapFields(({ item, threadId, turnId }) => ({
  item: replaces(item, Schema.Json),
  threadId,
  turnId,
}));
export const UserMessageItem = UserMessageThreadItem.mapFields(({ id, type, content }) => ({
  id: replaces(id, Schema.NonEmptyString),
  type,
  content: replaces(content, Schema.Array(Schema.Json)),
}));
export const UserTextInput = TextUserInput.mapFields(({ type, text }) => ({ type, text }));
export const AgentMessageItem = AgentMessageThreadItem.mapFields(({ type, id, text, phase }) => ({
  type,
  id: replaces(id, Schema.NonEmptyString),
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
    Schema.Literal("imageGeneration" satisfies (typeof ImageGenerationThreadItem.Type)["type"]),
  ]),
  id: replaces(
    [
      CommandExecutionThreadItem.fields.id,
      FileChangeThreadItem.fields.id,
      McpToolCallThreadItem.fields.id,
      DynamicToolCallThreadItem.fields.id,
      WebSearchThreadItem.fields.id,
      ImageViewThreadItem.fields.id,
      ...ImageGenerationThreadItem.members.map((member) => member.fields.id),
    ],
    Schema.NonEmptyString,
  ),
  status: Schema.optionalKey(CommandExecutionThreadItem.fields.status),
  success: Schema.optionalKey(DynamicToolCallThreadItem.fields.success),
});
export const ThreadResumeResponse = GeneratedThreadResumeResponse.mapFields(
  ({ modelProvider, thread }) => ({
    modelProvider: replaces(modelProvider, EndpointName),
    thread: thread.mapFields(({ id, turns }) => ({
      id: replaces(id, HarnessSessionId),
      turns: Schema.Array(
        turns.value.mapFields(({ id, status, items }) => ({
          id: replaces(id, Schema.NonEmptyString),
          status,
          items: replaces(
            items,
            Schema.Array(
              Schema.Union([ToolItem, AgentMessageItem, Schema.Struct({ type: Schema.String })]),
            ),
          ),
        })),
      ),
    })),
  }),
);
export const TurnCompleted = TurnCompletedNotification.mapFields(({ turn }) => ({
  turn: turn.mapFields(({ id, status, error }) => ({
    id,
    status,
    error: replaces(
      error,
      Schema.optionalKey(
        Schema.NullOr(
          TurnError.mapFields(({ message, additionalDetails, codexErrorInfo }) => ({
            message,
            additionalDetails,
            // Error objects can gain new variants; turnFailure classifies only known capacity errors.
            codexErrorInfo: replaces(
              codexErrorInfo,
              Schema.optionalKey(
                Schema.NullOr(
                  Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Unknown)]),
                ),
              ),
            ),
          })),
        ),
      ),
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
export const CodexTokenUsage = ThreadTokenUsageUpdatedNotification.mapFields(
  ({ threadId, tokenUsage }) => ({
    threadId: replaces(threadId, Schema.NonEmptyString),
    tokenUsage: tokenUsage.mapFields(({ total }) => ({
      total: total.mapFields(
        ({ inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens }) => ({
          inputTokens: replaces(inputTokens, UsageCount),
          cachedInputTokens: replaces(cachedInputTokens, UsageCount),
          cacheWriteInputTokens: replaces(cacheWriteInputTokens, Schema.optionalKey(UsageCount)),
          outputTokens: replaces(outputTokens, UsageCount),
        }),
      ),
    })),
  }),
);
export type CodexTokenUsage = typeof CodexTokenUsage.Type;
