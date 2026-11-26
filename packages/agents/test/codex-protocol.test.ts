import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import {
  AccountResponse,
  AccountUpdated,
  AgentMessageItem,
  ModelListResponse,
  ThreadStartResponse,
  ThreadResumeResponse,
  TurnStartResponse,
  TurnCompleted,
  ToolItem,
  ItemNotification,
  RateLimitsUpdated,
  CodexTokenUsage,
  UserMessageItem,
  isTurnStatus,
  isToolStatus,
  isApprovalToolStatus,
  isMessagePhase,
  isAuthMode,
  isCodexErrorCode,
  replaces,
} from "../src/protocol/codex/codex.ts";
import packageJson from "../package.json" with { type: "json" };
import { CODEX_PROTOCOL } from "../src/protocol/codex/version.ts";
import { CODEX_CLI_VERSION, codex } from "../src/harness/codex/descriptor.ts";
import { unsupportedCodexVersion } from "../src/harness/codex/preflight.ts";
import { ThreadTokenUsageUpdatedNotification } from "../src/protocol/codex/generated.ts";
import { UsageCount } from "../src/protocol/count.ts";
import { expectTypeOf } from "vitest";

describe("generated Codex protocol selections", () => {
  it("requires replacements to accept the generated field's encoded type and nullability", () => {
    // @ts-expect-error A numeric replacement cannot decode a generated string field.
    replaces(Schema.String, Schema.Finite);
    // @ts-expect-error A replacement must preserve the generated field's null values.
    replaces(Schema.NullOr(Schema.String), Schema.String);

    expect(replaces(Schema.String, Schema.NonEmptyString)).toBe(Schema.NonEmptyString);
    const nullable = Schema.NullOr(Schema.String);
    expect(replaces(Schema.NullOr(Schema.NonEmptyString), nullable)).toBe(nullable);
  });

  it("requires replacements to preserve optional generated keys", () => {
    // @ts-expect-error A required replacement cannot decode an absent generated key.
    replaces(Schema.optionalKey(Schema.String), Schema.String);
    const count =
      ThreadTokenUsageUpdatedNotification.fields.tokenUsage.fields.total.fields
        .cacheWriteInputTokens;
    // @ts-expect-error The upstream token count key is optional.
    replaces(count, UsageCount);

    const optional = Schema.optionalKey(Schema.String);
    expect(replaces(Schema.optionalKey(Schema.NonEmptyString), optional)).toBe(optional);
  });

  it("restricts comparison targets to generated enum values while allowing unknown input", () => {
    expectTypeOf<"waitingForInput">().not.toExtend<Parameters<typeof isTurnStatus>[1]>();
    expectTypeOf<Parameters<typeof isToolStatus>[1]>().toEqualTypeOf<
      "inProgress" | "completed" | "failed"
    >();
    expectTypeOf<Parameters<typeof isApprovalToolStatus>[1]>().toEqualTypeOf<
      "inProgress" | "completed" | "failed" | "declined"
    >();
    expectTypeOf<"serverOverloaded" | "other">().toExtend<Parameters<typeof isCodexErrorCode>[1]>();
    expectTypeOf<"futureCode">().not.toExtend<Parameters<typeof isCodexErrorCode>[1]>();
    expectTypeOf<"new_phase">().not.toExtend<Parameters<typeof isMessagePhase>[1]>();
    expectTypeOf<"new_auth">().not.toExtend<Parameters<typeof isAuthMode>[1]>();
    expect(isTurnStatus("waitingForInput", "completed")).toBe(false);
    expect(isTurnStatus("completed", "completed")).toBe(true);
    expect(isToolStatus(undefined, "failed")).toBe(false);
    expect(isApprovalToolStatus("declined", "declined")).toBe(true);
    expect(isCodexErrorCode("futureCode", "other")).toBe(false);
    expect(isMessagePhase("new_phase", "final_answer")).toBe(false);
    expect(isMessagePhase("final_answer", "final_answer")).toBe(true);
    expect(isAuthMode(null, "chatgpt")).toBe(false);
    expect(isAuthMode("chatgpt", "chatgpt")).toBe(true);
  });

  it.effect("requires comparison inputs to be strings rather than whole protocol objects", () =>
    Effect.gen(function* () {
      const item = yield* Schema.decodeEffect(ToolItem)({
        type: "commandExecution",
        id: "command",
        status: "failed",
      });
      const { turn } = yield* Schema.decodeEffect(TurnCompleted)({
        turn: {
          id: "turn",
          status: "failed",
          error: { message: "Failed", codexErrorInfo: "other" },
        },
      });
      // @ts-expect-error Compare the item's status, not the item object.
      isToolStatus(item, "failed");
      // @ts-expect-error Compare the narrowed error code, not the error object.
      isCodexErrorCode(turn.error, "other");
    }),
  );

  it.effect("accepts responses that omit keys the upstream protocol marks optional", () =>
    Effect.gen(function* () {
      const models = yield* Schema.decodeEffect(ModelListResponse)({ data: [] });
      expect(models).toEqual({ data: [] });
      const started = yield* Schema.decodeEffect(ThreadStartResponse)({
        modelProvider: "openai",
        thread: { id: "thread" },
        model: "gpt-5.6-terra",
      });
      expect(started.thread.id).toBe("thread");
      const completion = yield* Schema.decodeEffect(TurnCompleted)({
        turn: { id: "turn", status: "completed" },
      });
      expect(completion.turn.error).toBeUndefined();
      const account = yield* Schema.decodeEffect(AccountResponse)({
        requiresOpenaiAuth: true,
      });
      expect(account.account).toBeUndefined();
      const usage = yield* Schema.decodeEffect(CodexTokenUsage)({
        threadId: "thread",
        tokenUsage: { total: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 1 } },
      });
      expect(usage.tokenUsage.total.cacheWriteInputTokens).toBeUndefined();
    }),
  );

  it.effect("decodes new enum members in saved turns and assistant messages", () =>
    Effect.gen(function* () {
      const response = yield* Schema.decodeEffect(ThreadResumeResponse)({
        modelProvider: "openai",
        thread: {
          id: "saved-thread",
          turns: [
            {
              id: "saved-turn",
              status: "waitingForInput",
              items: [
                { type: "agentMessage", id: "message", text: "Waiting", phase: "new_phase" },
                { type: "commandExecution", id: "command", status: "waitingForApproval" },
                { type: "futureItem", payload: { anything: true } },
              ],
            },
          ],
        },
      });
      expect(response.thread.turns[0]?.status).toBe("waitingForInput");
      const items = response.thread.turns[0]?.items ?? [];
      expect(items.filter(Schema.is(AgentMessageItem))[0]?.phase).toBe("new_phase");
      expect(items.filter(Schema.is(ToolItem))[0]?.status).toBe("waitingForApproval");
      expect(items.at(-1)).toEqual({ type: "futureItem", payload: { anything: true } });
      expect(Schema.is(ToolItem)({ type: "futureTool", id: "tool" })).toBe(false);
    }),
  );

  it.effect("decodes completion statuses without discarding new error variants", () =>
    Effect.gen(function* () {
      const completion = yield* Schema.decodeEffect(TurnCompleted)({
        turn: {
          id: "turn",
          status: "cancelled",
          error: {
            message: "cancelled",
            codexErrorInfo: { futureError: { httpStatusCode: 503 } },
          },
        },
      });
      expect(completion.turn.status).toBe("cancelled");
      expect(completion.turn.error?.codexErrorInfo).toEqual({
        futureError: { httpStatusCode: 503 },
      });
    }),
  );

  it.effect("validates selected fields while allowing unused response fields", () =>
    Effect.gen(function* () {
      const started = yield* Schema.decodeUnknownEffect(TurnStartResponse)({
        turn: { id: "turn", newField: true },
      });
      expect(started).toEqual({ turn: { id: "turn" } });
      expect(Schema.is(TurnStartResponse)({ turn: { id: "" } })).toBe(false);
      expect(Schema.is(TurnStartResponse)({ turn: { id: 123 } })).toBe(false);
      const notification = yield* Schema.decodeEffect(ItemNotification)({
        threadId: "thread",
        turnId: "turn",
        item: { type: "futureItem" },
      });
      expect(notification.item).toEqual({ type: "futureItem" });
    }),
  );

  it.effect("retains sparse rate windows and usage count validation", () =>
    Effect.gen(function* () {
      const rates = yield* Schema.decodeEffect(RateLimitsUpdated)({
        rateLimits: { primary: { usedPercent: 25 } },
      });
      expect(rates).toEqual({ rateLimits: { primary: { usedPercent: 25 } } });
      expect(
        Schema.is(CodexTokenUsage)({
          threadId: "thread",
          tokenUsage: {
            total: {
              inputTokens: -1,
              cachedInputTokens: 0,
              cacheWriteInputTokens: 0,
              outputTokens: 0,
            },
          },
        }),
      ).toBe(false);
    }),
  );

  it("accepts the installed release and the protocol baseline, and refuses other releases", () => {
    expect(packageJson.devDependencies["@pwrdrvr/codex-app-server-protocol"]).toBe(
      CODEX_PROTOCOL.version,
    );
    expect(codex.worker.install).toEqual([
      { name: "@openai/codex", version: CODEX_CLI_VERSION, method: "global" },
    ]);
    expect(codex.worker.versions).toContain(CODEX_CLI_VERSION);
    expect(codex.worker.versions).toContain(CODEX_PROTOCOL.version);
    expect(Option.isNone(unsupportedCodexVersion(`codex-cli ${CODEX_CLI_VERSION}`))).toBe(true);
    expect(Option.isSome(unsupportedCodexVersion("codex-cli 0.165.0"))).toBe(true);
  });
});

// Each case is a payload shape that Codex 0.172.0's schema adds to a type that the adapter selects
// from the 0.164.0 baseline.
describe("Codex 0.172.0 additions to the selected types", () => {
  it.effect("decodes a GCP account, a workspace name, a user ID, and an update reason", () =>
    Effect.gen(function* () {
      const gcp = yield* Schema.decodeUnknownEffect(AccountResponse)({
        account: { type: "gcp" },
        requiresOpenaiAuth: false,
        userId: "user",
      });
      expect(gcp.account).toEqual({ type: "gcp" });
      const chatgpt = yield* Schema.decodeUnknownEffect(AccountResponse)({
        account: {
          type: "chatgpt",
          email: "operator@example.com",
          planType: "pro",
          workspaceName: "Workspace",
        },
        requiresOpenaiAuth: true,
      });
      expect(chatgpt.account).toEqual({ type: "chatgpt", email: "operator@example.com" });
      const updated = yield* Schema.decodeUnknownEffect(AccountUpdated)({
        authMode: "chatgpt",
        reason: "workspaceRoutingReady",
      });
      expect(updated).toEqual({ authMode: "chatgpt" });
    }),
  );

  it.effect("decodes the new turn error codes", () =>
    Effect.gen(function* () {
      for (const code of ["modelNotFound", "projectSpendLimitExceeded", "inferenceHookDenied"]) {
        const completion = yield* Schema.decodeEffect(TurnCompleted)({
          turn: {
            id: "turn",
            status: "failed",
            error: { message: "Failed", codexErrorInfo: code },
          },
        });
        expect(completion.turn.error?.codexErrorInfo).toBe(code);
      }
    }),
  );

  it.effect("decodes item timestamps, content token counts, and new item fields", () =>
    Effect.gen(function* () {
      const notification = yield* Schema.decodeUnknownEffect(ItemNotification)({
        threadId: "thread",
        turnId: "turn",
        contentTokenCount: 12,
        item: {
          type: "functionCallOutput",
          startedAtMs: 1,
          completedAtMs: 2,
          output: [{ type: "inputAudio", file_id: "file" }],
        },
      });
      expect(notification.threadId).toBe("thread");
      const message = yield* Schema.decodeUnknownEffect(AgentMessageItem)({
        type: "agentMessage",
        id: "message",
        text: "Done",
        moderation: { moderated: false },
        startedAtMs: 1,
      });
      expect(message).toEqual({ type: "agentMessage", id: "message", text: "Done" });
      const user = yield* Schema.decodeEffect(UserMessageItem)({
        type: "userMessage",
        id: "user",
        content: [{ type: "audio", fileId: "file" }],
      });
      expect(user.content).toEqual([{ type: "audio", fileId: "file" }]);
      for (const item of [
        { type: "mcpToolCall", id: "mcp", status: "completed", environmentId: "env" },
        { type: "imageGeneration", id: "image", status: "completed", generationId: "generation" },
      ])
        expect(Schema.is(ToolItem)(item)).toBe(true);
    }),
  );

  it.effect("decodes models with Daybreak availability", () =>
    Effect.gen(function* () {
      const models = yield* Schema.decodeUnknownEffect(ModelListResponse)({
        data: [
          {
            id: "gpt-6.2-astra",
            model: "gpt-6.2-astra",
            availableAccessPrograms: { daybreakAvailability: "available" },
          },
        ],
        nextCursor: null,
      });
      expect(models.data).toEqual([{ id: "gpt-6.2-astra", model: "gpt-6.2-astra" }]);
    }),
  );

  it.effect("decodes the experimental thread start and resume fields", () =>
    Effect.gen(function* () {
      const extra = {
        activePermissionProfile: null,
        multiAgentMode: "default",
        runtimeWorkspaceRoots: ["/work"],
      };
      const started = yield* Schema.decodeUnknownEffect(ThreadStartResponse)({
        ...extra,
        modelProvider: "openai",
        thread: { id: "thread", canAcceptDirectInput: true, environments: null },
        model: "gpt-6.2-astra",
      });
      expect(started.thread.id).toBe("thread");
      const resumed = yield* Schema.decodeUnknownEffect(ThreadResumeResponse)({
        ...extra,
        initialTurnsPage: null,
        modelProvider: "openai",
        thread: { id: "thread", turns: [], extra: null },
      });
      expect(resumed.thread.turns).toEqual([]);
    }),
  );
});
