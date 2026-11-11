import { describe, expect, it } from "@effect/vitest";
import { AgentSessionId } from "@usine/core/agent/session";
import { Effect, Logger, Option, Schema } from "effect";
import {
  AccountResponse,
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
import { CODEX_CLI_VERSION } from "../src/harness/codex/descriptor.ts";
import { unsupportedCodexVersion } from "../src/harness/codex/preflight.ts";
import { decodeToolItem, resumedToolItems } from "../src/harness/codex/codec.ts";
import {
  CommandExecutionStatusValues,
  DynamicToolCallStatusValues,
  ImageGenerationThreadItem,
  McpToolCallStatusValues,
  PatchApplyStatusValues,
  ThreadTokenUsageUpdatedNotification,
} from "../src/protocol/codex/generated.ts";
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

  it("compares tool statuses against the status list of each compared tool kind", () => {
    const expectLists = (
      actual: ReadonlyArray<ReadonlyArray<string>>,
      expected: ReadonlyArray<ReadonlyArray<string>>,
    ) => {
      expect(actual).toHaveLength(expected.length);
      // Identity, not equality: the command and file-change lists have the same members.
      expected.forEach((list, index) => expect(actual[index]).toBe(list));
    };
    expectLists(isToolStatus.lists, [
      CommandExecutionStatusValues,
      PatchApplyStatusValues,
      McpToolCallStatusValues,
      DynamicToolCallStatusValues,
    ]);
    expectLists(isApprovalToolStatus.lists, [CommandExecutionStatusValues, PatchApplyStatusValues]);
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

  it.effect("keeps common fields on generated image payload alternatives", () =>
    Effect.gen(function* () {
      expectTypeOf<
        Pick<typeof ImageGenerationThreadItem.Type, "id" | "type" | "status">
      >().toEqualTypeOf<{
        readonly id: string;
        readonly type: "imageGeneration";
        readonly status: string;
      }>();
      for (const payload of [{ fileId: "file" }, { result: "image-data" }]) {
        const image = yield* Schema.decodeEffect(ImageGenerationThreadItem)({
          id: "image",
          type: "imageGeneration",
          status: "completed",
          ...payload,
        });
        expect(image).toEqual({
          id: "image",
          type: "imageGeneration",
          status: "completed",
          ...payload,
        });
      }
    }),
  );

  it("requires the common fields on each image payload alternative", () => {
    const image = { id: "image", type: "imageGeneration", status: "completed", fileId: "file" };
    for (const field of ["id", "type", "status"] as const) {
      const { [field]: _, ...missing } = image;
      expect(Schema.is(ImageGenerationThreadItem)(missing)).toBe(false);
    }
    expect(Schema.is(ImageGenerationThreadItem)(image)).toBe(true);
    expect(Schema.is(ToolItem)({ type: "imageGeneration", id: "image" })).toBe(true);
  });

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
      const response = yield* Schema.decodeUnknownEffect(ThreadResumeResponse)({
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
      expect(items.at(-1)?.type).toBe("futureItem");
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

  it("matches the preflight baseline and refuses a newer worker protocol", () => {
    expect(CODEX_PROTOCOL.version).toBe(CODEX_CLI_VERSION);
    expect(packageJson.devDependencies["@pwrdrvr/codex-app-server-protocol"]).toBe(
      CODEX_PROTOCOL.version,
    );
    expect(Option.isNone(unsupportedCodexVersion(`codex-cli ${CODEX_PROTOCOL.version}`))).toBe(
      true,
    );
    expect(Option.isSome(unsupportedCodexVersion("codex-cli 0.165.0"))).toBe(true);
  });
});

describe("Codex tool item decoding", () => {
  const sessionId = AgentSessionId.make("session");

  it.effect("logs a tool item that does not decode and skips other item kinds silently", () =>
    Effect.gen(function* () {
      const warnings: Array<unknown> = [];
      const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
        if (logLevel === "Warn") warnings.push(message);
      });
      const decode = (item: Schema.Json) =>
        decodeToolItem(sessionId, item).pipe(Effect.provide(Logger.layer([logger])));

      const tool = yield* decode({ type: "mcpToolCall", id: "call", status: "completed" });
      expect(Option.map(tool, ({ id }) => id)).toEqual(Option.some("call"));
      const reasoning = yield* decode({ type: "reasoning", id: "thought" });
      expect(reasoning).toEqual(Option.none());
      expect(warnings).toEqual([]);

      const malformed = yield* decode({ type: "mcpToolCall", status: "completed" });
      expect(malformed).toEqual(Option.none());
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toEqual([
        "Skipping an undecodable Codex tool item",
        expect.objectContaining({ sessionId, itemType: "mcpToolCall" }),
      ]);
    }),
  );

  it.effect("logs the type of a resumed tool item that does not decode", () =>
    Effect.gen(function* () {
      const warnings: Array<unknown> = [];
      const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
        if (logLevel === "Warn") warnings.push(message);
      });
      const response = yield* Schema.decodeUnknownEffect(ThreadResumeResponse)({
        modelProvider: "openai",
        thread: {
          id: "saved-thread",
          turns: [
            {
              id: "saved-turn",
              status: "inProgress",
              items: [
                { type: "dynamicToolCall", id: "", status: "inProgress" },
                { type: "commandExecution", id: "command", status: "inProgress" },
                { type: "reasoning", id: "thought" },
              ],
            },
          ],
        },
      });
      const tools = yield* resumedToolItems(sessionId, response.thread.turns[0]?.items ?? []).pipe(
        Effect.provide(Logger.layer([logger])),
      );
      expect(tools.map(({ id }) => id)).toEqual(["command"]);
      expect(warnings).toEqual([
        [
          "Skipping an undecodable Codex tool item",
          { sessionId, itemType: "dynamicToolCall", resumed: true },
        ],
      ]);
    }),
  );
});
