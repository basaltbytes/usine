import { assert, describe, it } from "@effect/vitest";
import { Agent } from "@usine/core";
import { Effect, Layer, Schema, Stream } from "effect";
import {
  AgentResultError,
  ChildRequest,
  CodexChildBackend,
  SessionOperationError,
  UnknownModelError,
  WorkingDirectory,
} from "../../src/index.ts";
import {
  CodexAppServer,
  codexAppServerCommand,
  codexChildBackendLayer,
  type CodexConnection,
  type CodexNotification,
} from "../../src/pi/codex.ts";

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
  models: ReadonlyArray<{ readonly id: string; readonly model: string }>,
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
  it("starts app-server outside the worktree with repository config untrusted", () => {
    const command = codexAppServerCommand("/workspace/repo");
    assert.strictEqual(command._tag, "StandardCommand");
    if (command._tag !== "StandardCommand") return;
    assert.notStrictEqual(command.options.cwd, "/workspace/repo");
    assert.deepStrictEqual(command.args, [
      "app-server",
      "--stdio",
      "-c",
      'projects."/workspace/repo".trust_level="untrusted"',
    ]);
  });

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
