import { assert, describe, it } from "@effect/vitest";
import { BrainSpec, Effort, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, ChildSession } from "@usine/core/agent/session";
import { AgentName } from "@usine/core/agent";
import {
  Cause,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Result,
  Schema,
  Stream,
} from "effect";
import { Interrupt, OperatorMessage, Release } from "@usine/core/attempt/channel";
import { TestClock } from "effect/testing";
import { type ChildHost, LocalProcess, RemoteShell } from "../../../src/child-host/child-host.ts";
import {
  AgentResultError,
  ChildRequest,
  CodexChildBackend,
  PoolUnavailableError,
  toAttemptFailure,
  SessionOperationError,
  UnknownModelError,
  UnsupportedEffortError,
  WorkingDirectory,
} from "../../../src/runtime.ts";
import {
  CodexAppServer,
  type CodexClient,
  type CodexConnection,
  type CodexNotification,
} from "../../../src/pi/codex/app-server.ts";
import { codexChildBackendLayer } from "../../../src/pi/codex/codex.ts";

const request = (
  model = "gpt-5.6-terra",
  effort: Effort = "off",
  host: ChildHost = new LocalProcess(),
) =>
  new ChildRequest({
    environment: { HOME: "/home/worker", PATH: "/usr/bin:/bin" },
    host,
    session: new ChildSession({
      id: AgentSessionId.make("codex-child-1"),
      parentId: AgentSessionId.make("parent-1"),
      agent: AgentName.make("developer"),
      brain: new BrainSpec({
        harness: "codex",
        model: ModelId.make(model),
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
  close: CodexConnection["close"] = Effect.void,
  clients: Array<CodexClient> = [],
) =>
  Layer.succeed(CodexAppServer)({
    open: (client) =>
      Effect.sync(() => clients.push(client)).pipe(
        Effect.as({
          close,
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
                  sessionId: Option.none(),
                  message: `Unexpected ${method}`,
                  cause: new Error(method),
                });
              }
              return response;
            }),
        } satisfies CodexConnection),
      ),
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
    "account/read": { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
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
  it.effect(
    "pauses without closing Codex and resumes a held conversation on its existing thread",
    () =>
      Effect.gen(function* () {
        const notifications = yield* Queue.make<CodexNotification, Cause.Done>();
        const idle = yield* Queue.make<void>();
        const calls: Array<{ readonly method: string; readonly params: Schema.Json }> = [];
        const responses: Readonly<Record<string, Schema.Json>> = successfulResponses([
          { id: "gpt-5.6-terra", model: "gpt-5.6-terra" },
        ]);
        let turns = 0;
        let closes = 0;
        let pauseRefused = false;
        const server = Layer.succeed(CodexAppServer)({
          open: () =>
            Effect.succeed({
              notifications: Stream.fromQueue(notifications),
              notify: () => Effect.void,
              close: Effect.sync(() => {
                closes += 1;
              }).pipe(Effect.andThen(Queue.end(notifications))),
              request: (_operation, method, params) =>
                Effect.gen(function* () {
                  calls.push({ method, params });
                  if (method === "turn/interrupt" && !pauseRefused) {
                    pauseRefused = true;
                    return yield* new SessionOperationError({
                      operation: "interrupt",
                      sessionId: Option.none(),
                      message: "Temporary interrupt refusal",
                      cause: new Error("retry"),
                    });
                  }
                  if (method === "turn/start") {
                    turns += 1;
                    return { turn: { id: `turn-${turns}` } };
                  }
                  return responses[method] ?? {};
                }),
            }),
        });
        yield* Effect.gen(function* () {
          const running = yield* (yield* CodexChildBackend).launch(request());
          const result = yield* Effect.forkScoped(running.result);
          yield* Effect.forkScoped(
            running.events.pipe(
              Stream.runForEach((event) =>
                event._tag === "SessionIdle" ? Queue.offer(idle, undefined) : Effect.void,
              ),
            ),
          );
          const refused = yield* Effect.flip(running.intervene(new Interrupt()));
          assert.strictEqual(refused._tag, "SessionOperationError");
          yield* running.intervene(new Interrupt());
          assert.strictEqual(calls.filter(({ method }) => method === "turn/interrupt").length, 2);
          yield* Queue.offer(notifications, {
            method: "turn/completed",
            params: { turn: { id: "turn-1", status: "interrupted", error: null } },
          });
          yield* Queue.take(idle);
          assert.strictEqual(result.pollUnsafe(), undefined);
          assert.strictEqual(closes, 0);
          yield* running.intervene(new OperatorMessage({ message: "Continue with my correction" }));
          assert.strictEqual(turns, 2);
          yield* Queue.offer(notifications, {
            method: "item/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-2",
              item: { type: "agentMessage", id: "second-answer", text: "Corrected result" },
            },
          });
          yield* Queue.offer(notifications, {
            method: "turn/completed",
            params: { turn: { id: "turn-2", status: "completed", error: null } },
          });
          yield* Queue.take(idle);
          assert.strictEqual(result.pollUnsafe(), undefined);
          yield* running.intervene(new Release());
          assert.strictEqual((yield* Fiber.join(result)).message, "Corrected result");
          assert.strictEqual(closes, 1);
          assert.strictEqual(calls.filter(({ method }) => method === "thread/start").length, 1);
        }).pipe(Effect.provide(codexChildBackendLayer), Effect.provide(server));
      }).pipe(Effect.scoped),
  );
  for (const status of ["completed", "interrupted"] as const) {
    it.effect(`waits for shutdown before publishing ${status} work`, () =>
      Effect.gen(function* () {
        const closing = yield* Deferred.make<void>();
        const closed = yield* Deferred.make<void>();
        const server = connectionLayer(
          successfulResponses([{ id: "gpt-5.6-terra", model: "gpt-5.6-terra" }]),
          [
            {
              method: "item/completed",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                item: { type: "agentMessage", id: "message-1", text: "The fix is ready." },
              },
            },
            {
              method: "turn/completed",
              params: { turn: { id: "turn-1", status, error: null } },
            },
          ],
          [],
          Deferred.succeed(closing, undefined).pipe(Effect.andThen(Deferred.await(closed))),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const backend = yield* CodexChildBackend;
            const running = yield* backend.launch(request());
            const result = yield* running.result.pipe(Effect.result, Effect.forkChild);
            const events = yield* running.events.pipe(
              Stream.runCollect,
              Effect.result,
              Effect.forkChild,
            );
            yield* Effect.raceFirst(
              Deferred.await(closing),
              Fiber.join(result).pipe(
                Effect.andThen(Effect.die(new Error("session settled before shutdown began"))),
              ),
            );
            yield* TestClock.adjust(0);
            assert.strictEqual(result.pollUnsafe(), undefined, "the session still owns resources");
            assert.strictEqual(events.pollUnsafe(), undefined, "the transcript is still open");

            yield* Deferred.succeed(closed, undefined);
            const outcome = yield* Fiber.join(result);
            const transcript = yield* Fiber.join(events);
            assert.strictEqual(transcript._tag, outcome._tag);
            if (status === "completed") {
              assert(Result.isSuccess(outcome));
              assert.strictEqual(outcome.success.message, "The fix is ready.");
              assert(Result.isSuccess(transcript));
              assert.strictEqual(transcript.success.at(-1)?._tag, "SessionFinished");
            } else {
              assert(Result.isFailure(outcome));
              assert(outcome.failure instanceof AgentResultError);
            }
          }).pipe(
            Effect.ensuring(Deferred.succeed(closed, undefined)),
            Effect.provide(codexChildBackendLayer),
            Effect.provide(server),
          ),
        );
      }),
    );
  }

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
    const clients: Array<CodexClient> = [];
    const server = connectionLayer(
      successfulResponses([{ id: "gpt-5.6-terra", model: "gpt-5.6-terra" }]),
      notifications,
      calls,
      Effect.void,
      clients,
    );

    return Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* CodexChildBackend;
        const running = yield* backend.launch(request());
        assert.deepStrictEqual(
          clients.map(({ environment, host }) => [environment, host]),
          [[request().environment, new LocalProcess()]],
        );
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
        assert(
          Schema.is(
            Schema.Struct({
              approvalPolicy: Schema.String,
              sandbox: Schema.String,
              allowProviderModelFallback: Schema.Boolean,
              ephemeral: Schema.Boolean,
            }),
          )(thread),
        );
        assert.strictEqual(thread.approvalPolicy, "never");
        assert.strictEqual(thread.sandbox, "danger-full-access");
        assert.strictEqual(thread.allowProviderModelFallback, false);
        assert.strictEqual(thread.ephemeral, false);
        const started = events[0];
        assert(started?._tag === "SessionStarted");
        assert(Option.isSome(started.harnessSession));
        assert.strictEqual(started.harnessSession.value.id, "thread-1");
        assert.strictEqual(started.harnessSession.value.cwd, request().cwd);
        const turn = calls.find(({ method }) => method === "turn/start")?.params;
        assert(Schema.is(Schema.Struct({ effort: Schema.String }))(turn));
        assert.strictEqual(turn.effort, "none");
        assert(calls.some(({ method }) => method === "turn/steer"));
        assert(calls.some(({ method }) => method === "turn/interrupt"));
      }).pipe(Effect.provide(codexChildBackendLayer), Effect.provide(server)),
    );
  });

  it.effect("opens the app server on the child's remote host", () => {
    const host = new RemoteShell({
      ssh: { command: "ssh", args: [] },
      sshEnvironment: {},
      destination: "worker.exe.xyz",
    });
    const clients: Array<CodexClient> = [];
    const server = connectionLayer(
      successfulResponses([{ id: "gpt-5.6-terra", model: "gpt-5.6-terra" }]),
      [
        {
          method: "turn/completed",
          params: { turn: { id: "turn-1", status: "completed", error: null } },
        },
      ],
      [],
      Effect.void,
      clients,
    );
    return Effect.scoped(
      Effect.gen(function* () {
        yield* (yield* CodexChildBackend).launch(request(undefined, undefined, host));
        assert.deepStrictEqual(
          clients.map((client) => client.host),
          [host],
        );
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

  for (const account of [
    null,
    { type: "apiKey" },
    { type: "amazonBedrock" },
    { type: "unknown" },
  ]) {
    it.effect(
      `refuses ${account?.type ?? "logged-out"} authentication before starting a turn`,
      () => {
        const calls: Array<{ readonly method: string; readonly params: Schema.Json }> = [];
        const server = connectionLayer(
          {
            ...successfulResponses([]),
            "account/read": { account, requiresOpenaiAuth: true },
          },
          [],
          calls,
        );
        return Effect.scoped(
          Effect.gen(function* () {
            const backend = yield* CodexChildBackend;
            const error = yield* Effect.flip(backend.launch(request()));
            assert(error instanceof PoolUnavailableError);
            assert.strictEqual(toAttemptFailure(error)._tag, "AgentFailure");
            assert(
              !calls.some(({ method }) => method === "thread/start" || method === "turn/start"),
            );
          }).pipe(Effect.provide(codexChildBackendLayer), Effect.provide(server)),
        );
      },
    );
  }

  it.effect("stops attributing rate windows after a mid-session authentication change", () => {
    const server = connectionLayer(
      successfulResponses([{ id: "gpt-5.6-terra", model: "gpt-5.6-terra" }]),
      [
        { method: "account/updated", params: { authMode: "apikey" } },
        {
          method: "account/rateLimits/updated",
          params: { rateLimits: { primary: { usedPercent: 42 } } },
        },
      ],
    );
    return Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* CodexChildBackend;
        const running = yield* backend.launch(request());
        const error = yield* Effect.flip(running.result);
        assert(error instanceof PoolUnavailableError);
        const events: Array<{ readonly _tag: string }> = [];
        const streamError = yield* running.events.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          ),
          Effect.flip,
        );
        assert(streamError instanceof PoolUnavailableError);
        assert(!events.some((event) => event._tag === "PoolRateLimitsUpdated"));
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
