import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import {
  AgentMessageItem,
  ThreadResumeResponse,
  TurnStartResponse,
  TurnCompleted,
  ToolItem,
  ItemNotification,
  RateLimitsUpdated,
  CodexTokenUsage,
  isTurnStatus,
  isToolStatus,
  isMessagePhase,
  isAuthMode,
} from "../src/protocol/codex.ts";
import { CODEX_PROTOCOL } from "../src/protocol/codex-version.ts";
import { CODEX_CLI_VERSION } from "../src/harness/codex/descriptor.ts";
import { unsupportedCodexVersion } from "../src/harness/codex/preflight.ts";
import { ImageGenerationThreadItem } from "../src/protocol/codex.generated.ts";
import { expectTypeOf } from "vitest";

describe("generated Codex protocol selections", () => {
  it("restricts comparison targets to generated enum values while allowing unknown input", () => {
    expectTypeOf<"waitingForInput">().not.toExtend<Parameters<typeof isTurnStatus>[1]>();
    expectTypeOf<"waitingForApproval">().not.toExtend<Parameters<typeof isToolStatus>[1]>();
    expectTypeOf<"new_phase">().not.toExtend<Parameters<typeof isMessagePhase>[1]>();
    expectTypeOf<"new_auth">().not.toExtend<Parameters<typeof isAuthMode>[1]>();
    expect(isTurnStatus("waitingForInput", "completed")).toBe(false);
    expect(isTurnStatus("completed", "completed")).toBe(true);
    expect(isToolStatus(undefined, "failed")).toBe(false);
    expect(isToolStatus("declined", "declined")).toBe(true);
    expect(isMessagePhase("new_phase", "final_answer")).toBe(false);
    expect(isMessagePhase("final_answer", "final_answer")).toBe(true);
    expect(isAuthMode(null, "chatgpt")).toBe(false);
    expect(isAuthMode("chatgpt", "chatgpt")).toBe(true);
  });

  it.effect("keeps common fields on generated image payload alternatives", () =>
    Effect.gen(function* () {
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
    expect(Option.isNone(unsupportedCodexVersion(`codex-cli ${CODEX_PROTOCOL.version}`))).toBe(
      true,
    );
    expect(Option.isSome(unsupportedCodexVersion("codex-cli 0.165.0"))).toBe(true);
  });
});
