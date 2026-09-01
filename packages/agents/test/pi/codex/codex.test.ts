import { assert, describe, it } from "@effect/vitest";
import { Agent } from "@usine/core";
import { Effect, Layer, Schema, Stream } from "effect";
import {
  AgentResultError,
  ChildRequest,
  CodexChildBackend,
  SessionOperationError,
  UnknownModelError,
  UnsupportedEffortError,
  WorkingDirectory,
} from "../../../src/index.ts";
import {
  CodexAppServer,
  type CodexConnection,
  type CodexNotification,
} from "../../../src/pi/codex/app-server.ts";
import { codexChildBackendLayer } from "../../../src/pi/codex/codex.ts";

const request = (model = "gpt-5.6-terra", effort: Agent.Effort = "off") =>
  new ChildRequest({
    session: new Agent.ChildSession({
      id: Agent.SessionId.make("codex-child-1"),
      parentId: Agent.SessionId.make("parent-1"),
      agent: Agent.Name.make("developer"),
      brain: new Agent.BrainSpec({
        harness: "codex",
        model: Agent.ModelId.make(model),
        effort,
      }),
    }),
    cwd: WorkingDirectory.make("/workspace/repo"),
    prompt: "Implement the focused task.",
  });

const connectionLayer = (
  responses: Readonly<Record<string, Schema.Json>>,
  notifications: ReadonlyArray<CodexNotification> = [],
  calls: Array<{ readonly method: string; readonly params: Schema.Json }> = [],
) =>
  Layer.succeed(CodexAppServer)({
    open: () =>
      Effect.succeed({
        notifications: Stream.fromIterable(notifications),
        notify: (_operation, method, params) =>
          Effect.sync(() => {
            calls.push({ method, params });
          }),
        request: (_operation, method, params) =>
          Effect.gen(function* () {
            calls.push({ method, params });
            const response = responses[method];
            if (response === undefined) {
              return yield* new SessionOperationError({
                operation: "stream",
                sessionId: null,
                message: `Unexpected ${method}`,
                cause: new Error(method),
              });
            }
            return response;
          }),
      } satisfies CodexConnection),
  });

const successfulResponses = (
  models: ReadonlyArray<{
    readonly id: string;
    readonly model: string;
    readonly supportedReasoningEfforts?: ReadonlyArray<{ readonly reasoningEffort: string }>;
  }>,
) =>
  ({
    initialize: {},
    "model/list": { data: models, nextCursor: null },
    "thread/start": {
      thread: { id: "thread-1" },
      model: "gpt-5.6-terra",
      instructionSources: ["/workspace/repo/AGENTS.md"],
    },
    "turn/start": { turn: { id: "turn-1" } },
    "turn/steer": {},
    "turn/interrupt": {},
  }) satisfies Readonly<Record<string, Schema.Json>>;

describe("Codex child backend", () => {
  it.effect("normalizes completed messages, tools, and ChatGPT rate windows", () => {
    const calls: Array<{ readonly method: string; readonly params: Schema.Json }> = [];
    const notifications: ReadonlyArray<CodexNotification> = [
      {
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId: "turn-1", delta: "do not emit" },
      },
      {
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "commandExecution", id: "tool-1", status: "inProgress" },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "commandExecution", id: "tool-1", status: "completed" },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "agentMessage", id: "message-1", text: "Child completed the edit." },
        },
      },
      {
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            limitId: "codex",
            limitName: "ChatGPT",
            primary: { usedPercent: 24, windowDurationMins: 300, resetsAt: 1_800_000_000 },
            secondary: null,
          },
        },
      },
      {
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed", error: null } },
      },
    ];
    const server = connectionLayer(
      successfulResponses([{ id: "gpt-5.6-terra", model: "gpt-5.6-terra" }]),
      notifications,
      calls,
    );

    return Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* CodexChildBackend;
        const running = yield* backend.launch(request());
        yield* running.steer("Check the test output.");
        yield* running.interrupt;
        const [events, result] = yield* Effect.all([
          Stream.runCollect(running.events),
          running.result,
        ]);
        assert.strictEqual(result.message, "Child completed the edit.");
        assert.deepStrictEqual(
          events.map((event) => event._tag),
          [
            "SessionStarted",
            "ToolStarted",
            "ToolFinished",
            "TextOutput",
            "PoolRateLimitsUpdated",
            "SessionFinished",
          ],
        );
        assert.strictEqual(events.filter((event) => event._tag === "TextOutput").length, 1);
        const thread = calls.find(({ method }) => method === "thread/start")?.params;
        assert(Schema.is(Schema.Struct({ approvalPolicy: Schema.String }))(thread));
        assert.strictEqual(thread.approvalPolicy, "never");
        assert.strictEqual(thread.sandbox, "danger-full-access");
        assert.strictEqual(thread.allowProviderModelFallback, false);
        const turn = calls.find(({ method }) => method === "turn/start")?.params;
        assert(Schema.is(Schema.Struct({ effort: Schema.String }))(turn));
        assert.strictEqual(turn.effort, "none");
        assert(calls.some(({ method }) => method === "turn/steer"));
        assert(calls.some(({ method }) => method === "turn/interrupt"));
      }).pipe(Effect.provide(codexChildBackendLayer), Effect.provide(server)),
    );
  });

  it.effect("prefers the final_answer message over trailing commentary for the result", () => {
    const notifications: ReadonlyArray<CodexNotification> = [
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "agentMessage", id: "m-1", text: "Working on it.", phase: "commentary" },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "m-2",
            text: "The fix is done.",
            phase: "final_answer",
          },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "agentMessage", id: "m-3", text: "Cleaning up.", phase: "commentary" },
        },
      },
      {
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed", error: null } },
      },
    ];
    const server = connectionLayer(
      successfulResponses([{ id: "gpt-5.6-terra", model: "gpt-5.6-terra" }]),
      notifications,
    );
    return Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* CodexChildBackend;
        const running = yield* backend.launch(request());
        const [events, result] = yield* Effect.all([
          Stream.runCollect(running.events),
          running.result,
        ]);
        assert.strictEqual(result.message, "The fix is done.");
        assert.strictEqual(events.filter((event) => event._tag === "TextOutput").length, 3);
      }).pipe(Effect.provide(codexChildBackendLayer), Effect.provide(server)),
    );
  });

  it.effect("tolerates sparse rate windows, undecodable items, and unknown notifications", () => {
    const notifications: ReadonlyArray<CodexNotification> = [
      // Sparse rolling update: only the load figure of one window is present.
      {
        method: "account/rateLimits/updated",
        params: { rateLimits: { primary: { usedPercent: 91 } } },
      },
      // Undecodable item payload: logged and skipped, never fatal.
      { method: "item/completed", params: { nonsense: true } },
      // Server pushes with no normalized shape.
      { method: "error", params: { error: { message: "transient" }, willRetry: true } },
      { method: "thread/tokenUsage/updated", params: { tokens: 12 } },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "agentMessage", id: "m-1", text: "Done." },
        },
      },
      {
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed", error: null } },
      },
    ];
    const server = connectionLayer(
      successfulResponses([{ id: "gpt-5.6-terra", model: "gpt-5.6-terra" }]),
      notifications,
    );
    return Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* CodexChildBackend;
        const running = yield* backend.launch(request());
        const [events, result] = yield* Effect.all([
          Stream.runCollect(running.events),
          running.result,
        ]);
        assert.strictEqual(result.message, "Done.");
        assert.deepStrictEqual(
          events.map((event) => event._tag),
          ["SessionStarted", "PoolRateLimitsUpdated", "TextOutput", "SessionFinished"],
        );
      }).pipe(Effect.provide(codexChildBackendLayer), Effect.provide(server)),
    );
  });

  it.effect("marks a dynamic tool reporting success false as an error", () => {
    const notifications: ReadonlyArray<CodexNotification> = [
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "dynamicToolCall", id: "tool-1", success: false },
        },
      },
      {
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed", error: null } },
      },
    ];
    const server = connectionLayer(
      successfulResponses([{ id: "gpt-5.6-terra", model: "gpt-5.6-terra" }]),
      notifications,
    );
    return Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* CodexChildBackend;
        const running = yield* backend.launch(request());
        const events = yield* Stream.runCollect(running.events);
        const finished = events.find((event) => event._tag === "ToolFinished");
        assert(finished !== undefined && finished._tag === "ToolFinished");
        assert.strictEqual(finished.isError, true);
      }).pipe(Effect.provide(codexChildBackendLayer), Effect.provide(server)),
    );
  });

  it.effect("rejects a model absent from the app-server catalog", () => {
    const server = connectionLayer(
      successfulResponses([{ id: "gpt-5.6-sol", model: "gpt-5.6-sol" }]),
    );
    return Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* CodexChildBackend;
        const error = yield* Effect.flip(backend.launch(request("gpt-never-existed")));
        assert(error instanceof UnknownModelError);
        assert.strictEqual(error.harness, "codex");
      }).pipe(Effect.provide(codexChildBackendLayer), Effect.provide(server)),
    );
  });

  it.effect("rejects an effort the selected model does not support", () => {
    const server = connectionLayer(
      successfulResponses([
        {
          id: "gpt-5.6-terra",
          model: "gpt-5.6-terra",
          supportedReasoningEfforts: [
            { reasoningEffort: "low" },
            { reasoningEffort: "medium" },
            { reasoningEffort: "high" },
          ],
        },
      ]),
    );
    return Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* CodexChildBackend;
        const error = yield* Effect.flip(backend.launch(request("gpt-5.6-terra", "max")));
        assert(error instanceof UnsupportedEffortError);
        assert.strictEqual(error.effort, "max");
        assert.strictEqual(error.model, "gpt-5.6-terra");
      }).pipe(Effect.provide(codexChildBackendLayer), Effect.provide(server)),
    );
  });

  it.effect("maps a failed turn to agent work instead of infrastructure", () => {
    const server = connectionLayer(
      successfulResponses([{ id: "gpt-5.6-terra", model: "gpt-5.6-terra" }]),
      [
        {
          method: "turn/completed",
          params: {
            turn: {
              id: "turn-1",
              status: "failed",
              error: { message: "the agent could not finish", additionalDetails: null },
            },
          },
        },
      ],
    );
    return Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* CodexChildBackend;
        const running = yield* backend.launch(request());
        const error = yield* Effect.flip(running.result);
        assert(error instanceof AgentResultError);
        assert.strictEqual(error.message, "the agent could not finish");
      }).pipe(Effect.provide(codexChildBackendLayer), Effect.provide(server)),
    );
  });
});
