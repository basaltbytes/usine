import { CONTINUATION_MESSAGE } from "../../../src/harness/continuation.ts";
import { jsonKey } from "@usine/core/json-key";
import { assert, describe, it } from "@effect/vitest";
import { Harness, BrainSpec, Effort, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  ChildSession,
  EndpointName,
  HarnessSession,
  HarnessSessionId,
  PoolLogin,
  TokenBreakdown,
  sessionPool,
} from "@usine/core/agent/session";
import { AgentName } from "@usine/core/agent";
import {
  Cause,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Logger,
  Option,
  Queue,
  Result,
  Schema,
  Stream,
} from "effect";
import {
  Interrupt,
  Steer,
  type InterventionState,
  OperatorMessage,
  Release,
} from "@usine/core/attempt/channel";
import { WorkerName } from "@usine/core/worker";
import { TestClock } from "effect/testing";
import { type ChildHost, LocalProcess, RemoteShell } from "../../../src/child-host/child-host.ts";
import {
  AgentResultError,
  ChildRequest,
  ChildBackend,
  ChildSessionLifecycle,
  ChildSessionJournal,
  type OnDelivery,
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
} from "../../../src/harness/codex/app-server.ts";
import { ChildProcessLost } from "../../../src/child-host/process.ts";
import { codexChildLayer } from "../../../src/harness/codex/codex.ts";
import { collectLogs } from "../../logs.ts";

const noDelivery: OnDelivery = () => Effect.void;

const request = (
  model = "gpt-5.6-terra",
  effort: Effort = "off",
  host: ChildHost = LocalProcess.make(),
) =>
  ChildRequest.make({
    worker: WorkerName.make("worker-1"),
    machine: Option.none(),
    environment: { HOME: "/home/worker", PATH: "/usr/bin:/bin" },
    host,
    session: ChildSession.make({
      id: AgentSessionId.make("codex-child-1"),
      parentId: AgentSessionId.make("parent-1"),
      agent: AgentName.make("developer"),
      brain: BrainSpec.make({
        harness: Harness.make("codex"),
        model: ModelId.make(model),
        effort,
      }),
    }),
    cwd: WorkingDirectory.make("/workspace/repo"),
    prompt: "Implement the focused task.",
    receipts: Option.some([]),
  });

const connectionLayer = (
  responses: Readonly<Record<string, Schema.Json>>,
  notifications: ReadonlyArray<CodexNotification> = [],
  calls: Array<{ readonly method: string; readonly params: Schema.Json }> = [],
  close: CodexConnection["close"] = Effect.void,
  clients: Array<CodexClient> = [],
) =>
  Layer.succeed(CodexAppServer)({
    stop: () => Effect.void,
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
                return yield* SessionOperationError.make({
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
    "account/read": {
      account: { type: "chatgpt", email: "operator@example.com" },
      requiresOpenaiAuth: true,
    },
    "model/list": { data: models },
    "thread/start": {
      modelProvider: "openai",
      thread: { id: "thread-1" },
      model: "gpt-5.6-terra",
    },
    "turn/start": { turn: { id: "turn-1" } },
    "turn/steer": {},
    "turn/interrupt": {},
  }) satisfies Readonly<Record<string, Schema.Json>>;

describe("Codex child backend", () => {
  for (const savedAnswer of [false, true])
    it.effect(
      `reattaches an active saved turn without starting a second turn (saved answer: ${savedAnswer})`,
      () => {
        const original = request();
        const unread = [
          Steer.make({ message: "Check the diff" }),
          Steer.make({ message: "Check the diff" }),
        ];
        const delivered: string[] = [];
        const calls: Array<{ readonly method: string; readonly params: Schema.Json }> = [];
        const logs = collectLogs(["Info", "Warn"]);
        const skips = [
          "Skipping an undecodable Codex tool item",
          "Skipping a Codex item without a transcript event",
          "Skipping an undecodable Codex agent message",
          "Skipping an undecodable Codex user message",
        ];
        const server = connectionLayer(
          {
            ...successfulResponses([{ id: "gpt-5.6-terra", model: "gpt-5.6-terra" }]),
            "thread/resume": {
              modelProvider: "openai",
              thread: {
                id: "thread-1",
                turns: [
                  {
                    id: "active-turn",
                    status: "inProgress",
                    items: [
                      { type: "commandExecution", id: "tool-1", status: "inProgress" },
                      { type: "mcpToolCall", status: "inProgress" },
                      { type: "agentMessage", id: "", text: "Saved without an id" },
                      ...(savedAnswer
                        ? [
                            {
                              type: "agentMessage",
                              id: "answer",
                              text: "Original turn completed",
                              phase: "final_answer",
                            },
                          ]
                        : []),
                    ],
                  },
                ],
              },
            },
          },
          [
            ...["steer-1", "steer-1", "steer-2"].map((id) => ({
              method: "item/started",
              params: {
                threadId: "thread-1",
                turnId: "active-turn",
                item: {
                  type: "userMessage",
                  id,
                  content: [{ type: "text", text: "Check the diff", text_elements: [] }],
                },
              },
            })),
            ...[
              { type: "userMessage", id: "steer-3" },
              { type: "fileChange", status: "inProgress" },
              { type: "collabAgentToolCall", id: "agent-1" },
            ].map((item) => ({
              method: "item/started",
              params: { threadId: "thread-1", turnId: "active-turn", item },
            })),
            {
              method: "item/completed",
              params: {
                threadId: "thread-1",
                turnId: "active-turn",
                item: { type: "commandExecution", id: "tool-1", status: "completed" },
              },
            },
            {
              method: "item/completed",
              params: {
                threadId: "thread-1",
                turnId: "active-turn",
                item: { type: "agentMessage", id: "broken", phase: "final_answer" },
              },
            },
            ...(!savedAnswer
              ? [
                  {
                    method: "item/completed",
                    params: {
                      threadId: "thread-1",
                      turnId: "active-turn",
                      item: {
                        type: "agentMessage",
                        id: "answer",
                        text: "Original turn completed",
                        phase: "final_answer",
                      },
                    },
                  },
                ]
              : []),
            {
              method: "turn/completed",
              params: { turn: { id: "active-turn", status: "completed", error: null } },
            },
          ],
          calls,
        );
        return Effect.scoped(
          Effect.gen(function* () {
            const running = yield* (yield* ChildBackend).launch(
              ChildRequest.make({
                ...original,
                unread: unread.map(({ id, message }) => ({ id, message })),
                resume: Option.some(
                  HarnessSession.make({ id: HarnessSessionId.make("thread-1"), cwd: original.cwd }),
                ),
              }),
            );
            const result = yield* running.result;
            assert.strictEqual(result.message, "Original turn completed");
            assert.isFalse(calls.some(({ method }) => method === "turn/start"));
            assert.isFalse(calls.some(({ method }) => method === "turn/steer"));
            assert.deepStrictEqual(
              delivered,
              unread.map(({ id }) => id),
            );
            assert.deepStrictEqual(
              logs.records.flatMap(({ level, message, annotations }) =>
                Array.isArray(message) && skips.includes(message[0])
                  ? [{ level, message: message[0], itemType: annotations["itemType"] }]
                  : [],
              ),
              [
                { level: "Warn", message: skips[0], itemType: "mcpToolCall" },
                { level: "Warn", message: skips[2], itemType: "agentMessage" },
                { level: "Warn", message: skips[3], itemType: "userMessage" },
                { level: "Warn", message: skips[0], itemType: "fileChange" },
                { level: "Info", message: skips[1], itemType: "collabAgentToolCall" },
                { level: "Warn", message: skips[2], itemType: "agentMessage" },
              ],
            );
          }),
        ).pipe(
          Effect.provide(
            codexChildLayer.pipe(Layer.provide(server), Layer.provideMerge(logs.layer)),
          ),
          Effect.provideService(ChildSessionJournal, {
            started: () => Effect.void,
            prompted: Effect.void,
            continued: () => Effect.void,
            received: () => Effect.void,
            delivered: (id, state) =>
              Effect.sync(() => {
                assert(Option.isSome(state));
                delivered.push(id);
              }),
          }),
        );
      },
    );

  it.effect("acknowledges one restored message for a repeated userMessage item", () => {
    const original = request();
    const unread = [
      Steer.make({ message: "Check the diff" }),
      Steer.make({ message: "Check the diff" }),
    ];
    const receipts: Array<string> = [];
    const server = connectionLayer(
      {
        ...successfulResponses([{ id: "gpt-5.6-terra", model: "gpt-5.6-terra" }]),
        "thread/resume": {
          modelProvider: "openai",
          thread: {
            id: "thread-1",
            turns: [{ id: "active-turn", status: "inProgress", items: [] }],
          },
        },
      },
      [
        ...["steer-1", "steer-1"].map((id) => ({
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "active-turn",
            item: {
              type: "userMessage",
              id,
              content: [{ type: "text", text: "Check the diff", text_elements: [] }],
            },
          },
        })),
        {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "active-turn",
            item: { type: "agentMessage", id: "answer", text: "Checked", phase: "final_answer" },
          },
        },
        {
          method: "turn/completed",
          params: { turn: { id: "active-turn", status: "completed", error: null } },
        },
      ],
    );
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const running = yield* (yield* ChildBackend).launch(
          ChildRequest.make({
            ...original,
            unread: unread.map(({ id, message }) => ({ id, message })),
            resume: Option.some(
              HarnessSession.make({ id: HarnessSessionId.make("thread-1"), cwd: original.cwd }),
            ),
          }),
        );
        assert.strictEqual((yield* running.result).message, "Checked");
      }).pipe(Effect.scoped);
      assert.deepStrictEqual(receipts, [`read ${unread[0]?.id}`, `unread ${unread[1]?.id}`]);
    }).pipe(
      Effect.provide(codexChildLayer.pipe(Layer.provide(server))),
      Effect.provideService(ChildSessionJournal, {
        started: () => Effect.void,
        prompted: Effect.void,
        continued: () => Effect.void,
        received: () => Effect.void,
        delivered: (id, state) =>
          Effect.sync(() => {
            receipts.push(`${Option.isSome(state) ? "read" : "unread"} ${id}`);
          }),
      }),
    );
  });

  for (const field of ["home", "default-home", "model_provider"] as const) {
    it.effect(`refuses a saved Codex continuation after its ${field} changes`, () => {
      const original = request(
        "gpt-5.6-terra",
        "off",
        RemoteShell.make({
          ssh: { command: "ssh", args: [] },
          sshEnvironment: {},
          destination: "worker",
        }),
      );
      const saved = HarnessSession.make({
        id: HarnessSessionId.make("saved-codex"),
        cwd: original.cwd,
        home: Option.some(
          field === "default-home" ? "/old-home/.codex" : "/attempt/original-codex",
        ),
        modelProvider: Option.some(EndpointName.make("usine-gateway")),
      });
      const calls: Array<{ readonly method: string; readonly params: Schema.Json }> = [];
      const clients: Array<CodexClient> = [];
      const server = connectionLayer(
        {
          ...successfulResponses([{ id: "gpt-5.6-terra", model: "gpt-5.6-terra" }]),
          "thread/resume": {
            modelProvider: "changed-provider",
            thread: { id: saved.id, turns: [] },
          },
        },
        [],
        calls,
        Effect.void,
        clients,
      );
      return Effect.scoped(
        Effect.gen(function* () {
          const error = yield* (yield* ChildBackend)
            .launch(
              ChildRequest.make({
                ...original,
                resume: Option.some(saved),
                environment:
                  field === "default-home"
                    ? { ...original.environment, HOME: "/new-home", CODEX_HOME: "" }
                    : {
                        ...original.environment,
                        CODEX_HOME:
                          field === "home" ? "/attempt/moved-codex" : "/attempt/original-codex",
                      },
              }),
            )
            .pipe(Effect.flip);
          assert.strictEqual(error._tag, "ContinuationMismatchError");
          assert.include(error.message, `${field === "default-home" ? "home" : field} mismatch`);
          assert.include(
            error.message,
            field === "home"
              ? "/attempt/original-codex"
              : field === "default-home"
                ? "/old-home/.codex"
                : "usine-gateway",
          );
          assert.include(
            error.message,
            field === "home"
              ? "/attempt/moved-codex"
              : field === "default-home"
                ? "/new-home/.codex"
                : "changed-provider",
          );
          assert(!calls.some(({ method }) => method === "turn/start"));
          assert.strictEqual(clients.length, 1, "the old transport is replaced before refusal");
          assert.strictEqual(clients[0]?.transport, "resume");
          assert.deepStrictEqual(clients[0]?.sessionId, Option.some(original.session.id));
        }),
      ).pipe(Effect.provide(codexChildLayer.pipe(Layer.provide(server))));
    });
  }

  it.effect("reports a failed native reopen as interrupted without starting a turn", () => {
    const original = request();
    const saved = HarnessSession.make({ cwd: original.cwd });
    const calls: Array<{ readonly method: string; readonly params: Schema.Json }> = [];
    const server = connectionLayer(
      successfulResponses([{ id: "gpt-5.6-terra", model: "gpt-5.6-terra" }]),
      [],
      calls,
    );
    return Effect.scoped(
      Effect.gen(function* () {
        const error = yield* (yield* ChildBackend)
          .launch(ChildRequest.make({ ...original, resume: Option.some(saved) }))
          .pipe(Effect.flip);
        assert.strictEqual(error._tag, "SessionInterruptedError");
        assert(calls.some(({ method }) => method === "thread/resume"));
        assert(!calls.some(({ method }) => method === "turn/start"));
      }),
    ).pipe(Effect.provide(codexChildLayer.pipe(Layer.provide(server))));
  });

  it.effect("stops a retained remote child without resuming its conversation", () => {
    const original = request(
      "gpt-5.6-terra",
      "off",
      RemoteShell.make({
        ssh: { command: "ssh", args: [] },
        sshEnvironment: {},
        destination: "worker",
      }),
    );
    const clients: Array<CodexClient> = [];
    const calls: Array<{ readonly method: string; readonly params: Schema.Json }> = [];
    const server = Layer.succeed(CodexAppServer)({
      stop: (client) =>
        Effect.sync(() => {
          clients.push(client);
        }),
      open: () => Effect.die("stop must not open a protocol connection"),
    });
    return Effect.gen(function* () {
      yield* (yield* ChildBackend).stop(original);
      assert.strictEqual(clients.length, 1);
      assert.deepStrictEqual(clients[0]?.sessionId, Option.some(original.session.id));
      assert.deepStrictEqual(calls, []);
    }).pipe(Effect.provide(codexChildLayer.pipe(Layer.provide(server))));
  });

  it.effect("reattaches the remote owner when resuming a saved Codex thread", () => {
    const saved = HarnessSession.make({
      id: HarnessSessionId.make("saved-codex"),
      cwd: request().cwd,
      home: Option.some("/worker/attempt/codex"),
      modelProvider: Option.some(EndpointName.make("openai")),
    });
    const calls: Array<{ readonly method: string; readonly params: Schema.Json }> = [];
    const clients: Array<CodexClient> = [];
    const server = connectionLayer(
      {
        ...successfulResponses([{ id: "gpt-5.6-terra", model: "gpt-5.6-terra" }]),
        "thread/resume": { modelProvider: "openai", thread: { id: saved.id, turns: [] } },
      },
      [
        {
          method: "item/completed",
          params: {
            threadId: saved.id,
            turnId: "turn-1",
            item: { type: "agentMessage", id: "report", text: "Continued." },
          },
        },
        {
          method: "turn/completed",
          params: { turn: { id: "turn-1", status: "completed", error: null } },
        },
      ],
      calls,
      Effect.void,
      clients,
    );
    return Effect.scoped(
      Effect.gen(function* () {
        const running = yield* (yield* ChildBackend).launch(
          ChildRequest.make({
            ...request(
              "gpt-5.6-terra",
              "off",
              RemoteShell.make({
                ssh: { command: "ssh", args: [] },
                sshEnvironment: {},
                destination: "worker-1",
              }),
            ),
            environment: { ...request().environment, CODEX_HOME: "/worker/attempt/codex" },
            resume: Option.some(saved),
          }),
        );
        const events = yield* Effect.forkChild(Stream.runCollect(running.events));
        assert.strictEqual((yield* running.result).message, "Continued.");
        const transcript = yield* Fiber.join(events);
        const started = transcript.find((event) => event._tag === "SessionStarted");
        assert(started !== undefined);
        assert.deepStrictEqual(started.harnessSession, Option.some(saved));
        assert.strictEqual(clients[0]?.environment.CODEX_HOME, "/worker/attempt/codex");
        assert.strictEqual(clients[0]?.transport, "resume");
        assert(!calls.some(({ method }) => method === "thread/start"));
        assert.include(
          jsonKey(calls.find(({ method }) => method === "thread/resume")?.params),
          saved.id,
        );
        // A thread without turns never received its task, so recovery sends the task itself.
        const turns = calls
          .filter(({ method }) => method === "turn/start")
          .map(({ params }) => jsonKey(params));
        assert.lengthOf(turns, 1);
        assert.include(turns[0], request().prompt);
        assert.notInclude(turns[0], CONTINUATION_MESSAGE);
      }),
    ).pipe(Effect.provide(codexChildLayer.pipe(Layer.provide(server))));
  });

  for (const answered of [true, false])
    it.effect(
      `restores whether a held idle Codex report ${answered ? "answers" : "doesn't answer"} the operator`,
      () =>
        Effect.gen(function* () {
          const notifications = yield* Queue.make<CodexNotification, Cause.Done>();
          const saved = HarnessSession.make({
            id: HarnessSessionId.make("held-codex"),
            cwd: request().cwd,
          });
          const responses = new Map(
            Object.entries({
              ...successfulResponses([{ id: "gpt-5.6-terra", model: "gpt-5.6-terra" }]),
              "thread/resume": {
                modelProvider: "openai",
                thread: { id: saved.id, turns: [{ id: "turn-0", status: "completed", items: [] }] },
              },
            }),
          );
          const server = Layer.succeed(CodexAppServer)({
            stop: () => Effect.void,
            open: () =>
              Effect.succeed({
                notifications: Stream.fromQueue(notifications),
                notify: () => Effect.void,
                close: Queue.end(notifications).pipe(Effect.asVoid),
                request: (_operation, method) =>
                  Effect.sync(() => {
                    const response = responses.get(method);
                    assert(response !== undefined);
                    return response;
                  }),
              }),
          });
          const result = yield* Effect.gen(function* () {
            const running = yield* (yield* ChildBackend).launch(
              ChildRequest.make({
                ...request(),
                resume: Option.some(saved),
                environment: {
                  ...request().environment,
                  ...Option.match(saved.home, {
                    onNone: () => ({}),
                    onSome: (home) => ({ CODEX_HOME: home }),
                  }),
                },
                held: true,
                idle: Option.some("The tests need a database."),
                idleAnsweredOperator: answered,
              }),
            );
            yield* running.intervene(Release.make(), noDelivery);
            return yield* running.result;
          }).pipe(Effect.provide(codexChildLayer.pipe(Layer.provide(server))));
          assert.strictEqual(result.message, "The tests need a database.");
          assert.strictEqual(result.answeredOperator, answered);
        }).pipe(Effect.scoped),
    );

  for (const supervision of ["paused", "held-idle", "held-idle-steer"] as const) {
    it.effect(`restores a ${supervision} Codex child without starting a turn`, () =>
      Effect.gen(function* () {
        const notifications = yield* Queue.make<CodexNotification, Cause.Done>();
        const calls: string[] = [];
        const saved = HarnessSession.make({
          id: HarnessSessionId.make("paused-codex"),
          cwd: request().cwd,
        });
        const responses = new Map(
          Object.entries({
            ...successfulResponses([{ id: "gpt-5.6-terra", model: "gpt-5.6-terra" }]),
            "thread/resume": {
              modelProvider: "openai",
              thread: { id: saved.id, turns: [{ id: "turn-0", status: "completed", items: [] }] },
            },
          }),
        );
        const server = Layer.succeed(CodexAppServer)({
          stop: () => Effect.void,
          open: () =>
            Effect.succeed({
              notifications: Stream.fromQueue(notifications),
              notify: () => Effect.void,
              close: Queue.end(notifications).pipe(Effect.asVoid),
              request: (_operation, method, params) =>
                Effect.sync(() => {
                  calls.push(method);
                  if (method === "turn/start")
                    assert.include(jsonKey(params), "Continue with the correction.");
                  const response = responses.get(method);
                  assert(response !== undefined);
                  return response;
                }),
            }),
        });
        yield* Effect.gen(function* () {
          const running = yield* (yield* ChildBackend).launch(
            ChildRequest.make({
              ...request(),
              resume: Option.some(saved),
              environment: {
                ...request().environment,
                ...Option.match(saved.home, {
                  onNone: () => ({}),
                  onSome: (home) => ({ CODEX_HOME: home }),
                }),
              },
              held: supervision !== "paused",
              paused: supervision === "paused",
              idle: supervision === "paused" ? Option.none() : Option.some("Saved final report."),
            }),
          );
          const seen = yield* running.events.pipe(Stream.take(2), Stream.runCollect);
          assert.deepStrictEqual(
            seen.map((event) => event._tag),
            ["SessionStarted", "SessionIdle"],
          );
          assert.notInclude(calls, "turn/start");
          if (supervision === "held-idle") {
            yield* running.intervene(Release.make(), noDelivery);
            assert.strictEqual((yield* running.result).message, "Saved final report.");
            assert.notInclude(calls, "turn/start");
            return;
          }
          if (supervision === "paused") {
            const state = yield* running.intervene(Release.make(), noDelivery);
            assert.isTrue(state.paused);
            assert.notInclude(calls, "turn/start");
          }
          yield* running.intervene(
            OperatorMessage.make({ message: "Continue with the correction." }),
            noDelivery,
          );
          assert.lengthOf(
            calls.filter((method) => method === "turn/start"),
            1,
          );
          yield* Queue.offer(notifications, {
            method: "item/completed",
            params: {
              threadId: saved.id,
              turnId: "turn-1",
              item: { type: "agentMessage", id: "report", text: "Corrected." },
            },
          });
          yield* Queue.offer(notifications, {
            method: "turn/completed",
            params: { turn: { id: "turn-1", status: "completed", error: null } },
          });
          yield* running.intervene(Release.make(), noDelivery);
          assert.strictEqual((yield* running.result).message, "Corrected.");
        }).pipe(Effect.provide(codexChildLayer.pipe(Layer.provide(server))));
      }).pipe(Effect.scoped),
    );
  }

  for (const supervision of ["held", "paused"] as const) {
    it.effect(
      `sends a ${supervision} Codex child with an empty thread its task after a restart`,
      () =>
        Effect.gen(function* () {
          const notifications = yield* Queue.make<CodexNotification, Cause.Done>();
          const turns: Array<string> = [];
          const guidance = OperatorMessage.make({ message: "Check the tests" });
          const interrupts: Array<string> = [];
          const steers: Array<string> = [];
          const saved = HarnessSession.make({
            id: HarnessSessionId.make("unprompted-codex"),
            cwd: request().cwd,
          });
          const responses = new Map(
            Object.entries({
              ...successfulResponses([{ id: "gpt-5.6-terra", model: "gpt-5.6-terra" }]),
              "thread/resume": { modelProvider: "openai", thread: { id: saved.id, turns: [] } },
            }),
          );
          const server = Layer.succeed(CodexAppServer)({
            stop: () => Effect.void,
            open: () =>
              Effect.succeed({
                notifications: Stream.fromQueue(notifications),
                notify: () => Effect.void,
                close: Queue.end(notifications).pipe(Effect.asVoid),
                request: (_operation, method, params) =>
                  Effect.sync(() => {
                    if (method === "turn/start") turns.push(jsonKey(params));
                    if (method === "turn/steer") steers.push(jsonKey(params));
                    if (method === "turn/interrupt") interrupts.push(jsonKey(params));
                    return responses.get(method) ?? {};
                  }),
              }),
          });
          yield* Effect.gen(function* () {
            const running = yield* (yield* ChildBackend).launch(
              ChildRequest.make({
                ...request(),
                resume: Option.some(saved),
                held: supervision === "held",
                paused: supervision === "paused",
                unread: [{ id: guidance.id, message: guidance.message }],
              }),
            );
            assert.lengthOf(turns, 1);
            assert.include(turns[0], request().prompt);
            assert.notInclude(turns[0], CONTINUATION_MESSAGE);
            assert.lengthOf(interrupts, supervision === "paused" ? 1 : 0);
            assert.lengthOf(steers, supervision === "held" ? 1 : 0);
            if (supervision === "held") assert.include(steers[0], guidance.message);
            const answer = supervision === "paused" ? "Codex turn paused" : "Task done";
            yield* Queue.offerAll(
              notifications,
              supervision === "paused"
                ? [
                    {
                      method: "turn/completed",
                      params: { turn: { id: "turn-1", status: "interrupted", error: null } },
                    },
                  ]
                : [
                    {
                      method: "item/completed",
                      params: {
                        threadId: saved.id,
                        turnId: "turn-1",
                        item: { type: "agentMessage", id: "answer", text: "Task done" },
                      },
                    },
                    {
                      method: "turn/completed",
                      params: { turn: { id: "turn-1", status: "completed", error: null } },
                    },
                  ],
            );

            const seen = yield* running.events.pipe(
              Stream.takeUntil(
                (event) => event._tag === "SessionIdle" && Option.contains(event.message, answer),
              ),
              Stream.runCollect,
            );
            assert.isFalse(seen.some((event) => event._tag === "ToolStarted"));
            assert.lengthOf(turns, 1, "restored guidance cannot start another paused turn");
            if (supervision === "paused") {
              yield* running.intervene(OperatorMessage.make({ message: "Continue" }), noDelivery);
              assert.lengthOf(turns, 2);
              assert.include(turns[1], guidance.message);
              assert.lengthOf(interrupts, 1, "new operator input resumes the paused child");
            }
            // A held child gets its task without reporting the interrupted turn idle first.
            assert.deepStrictEqual(
              seen
                .map((event) => event._tag)
                .filter((tag) => ["SessionStarted", "SessionIdle", "SessionResumed"].includes(tag)),
              supervision === "paused"
                ? ["SessionStarted", "SessionIdle", "SessionResumed", "SessionIdle"]
                : ["SessionStarted", "SessionIdle"],
            );
          }).pipe(Effect.provide(codexChildLayer.pipe(Layer.provide(server))));
        }).pipe(Effect.scoped),
    );
  }

  for (const taskRecorded of [true, false])
    it.effect(
      `recovers a paused Codex child after losing its task turn (recorded: ${taskRecorded})`,
      () =>
        Effect.gen(function* () {
          const original = yield* Queue.make<
            CodexNotification,
            SessionOperationError | Cause.Done
          >();
          const restored = yield* Queue.make<CodexNotification, Cause.Done>();
          const recovered = yield* Deferred.make<void>();
          const methods: Array<string> = [];
          const saved = HarnessSession.make({
            id: HarnessSessionId.make("unprompted-codex"),
            cwd: request().cwd,
          });
          const responses: Readonly<Record<string, Schema.Json>> = successfulResponses([
            { id: "gpt-5.6-terra", model: "gpt-5.6-terra" },
          ]);
          const turns: Array<string> = [];
          let opens = 0;
          const server = Layer.succeed(CodexAppServer)({
            stop: () => Effect.void,
            open: () =>
              Effect.sync(() => {
                const first = opens++ === 0;
                return {
                  notifications: first
                    ? Stream.fromQueue(original)
                    : Stream.unwrap(
                        Deferred.succeed(recovered, undefined).pipe(
                          Effect.as(Stream.fromQueue(restored)),
                        ),
                      ),
                  notify: () => Effect.void,
                  close: Queue.end(restored),
                  request: (_operation, method, params) =>
                    Effect.sync(() => {
                      if (method === "turn/start" || method === "turn/interrupt")
                        methods.push(method);
                      if (method === "turn/start") turns.push(jsonKey(params));
                      if (method === "thread/resume")
                        return {
                          modelProvider: "openai",
                          thread: {
                            id: saved.id,
                            turns:
                              first || !taskRecorded
                                ? []
                                : [
                                    {
                                      id: "turn-1",
                                      status: "interrupted",
                                      items: [
                                        {
                                          type: "userMessage",
                                          id: "task",
                                          content: [
                                            {
                                              type: "text",
                                              text: request().prompt,
                                              text_elements: [],
                                            },
                                          ],
                                        },
                                      ],
                                    },
                                  ],
                          },
                        };
                      return responses[method] ?? {};
                    }),
                } satisfies CodexConnection;
              }),
          });
          yield* Effect.gen(function* () {
            const host = RemoteShell.make({
              ssh: { command: "ssh", args: [] },
              sshEnvironment: {},
              destination: "worker",
            });
            const running = yield* (yield* ChildBackend).launch(
              ChildRequest.make({
                ...request(undefined, undefined, host),
                resume: Option.some(saved),
                paused: true,
              }),
            );
            assert.lengthOf(turns, 1);
            assert.include(turns[0], request().prompt);
            yield* Queue.fail(
              original,
              SessionOperationError.make({
                operation: "stream",
                sessionId: Option.some(running.session.id),
                message: "App-server exited",
                cause: ChildProcessLost.make({ exitCode: 1, stderrTail: "App-server exited" }),
              }),
            );
            yield* Deferred.await(recovered);
            assert.deepStrictEqual(
              methods,
              taskRecorded
                ? ["turn/start", "turn/interrupt"]
                : ["turn/start", "turn/interrupt", "turn/start", "turn/interrupt"],
            );
            if (!taskRecorded)
              yield* Queue.offer(restored, {
                method: "turn/completed",
                params: { turn: { id: "turn-1", status: "interrupted", error: null } },
              });
            const lifecycle = new Set(["SessionStarted", "SessionIdle", "SessionResumed"]);
            const seen = yield* running.events.pipe(
              Stream.filter((event) => lifecycle.has(event._tag)),
              Stream.takeUntil(
                (event) =>
                  event._tag === "SessionIdle" &&
                  Option.contains(
                    event.message,
                    taskRecorded
                      ? "Session interrupted before its turn returned"
                      : "Codex turn paused",
                  ),
              ),
              Stream.runCollect,
            );
            // The task input ended the restored idle report, so the lost task turn reports idle.
            assert.deepStrictEqual(
              seen.map((event) => event._tag),
              ["SessionStarted", "SessionIdle", "SessionResumed", "SessionIdle"],
            );
            assert.strictEqual(opens, 2);
            assert.lengthOf(turns, taskRecorded ? 1 : 2);
            assert(turns.every((input) => input.includes(request().prompt)));
          }).pipe(Effect.provide(codexChildLayer.pipe(Layer.provideMerge(server))));
        }).pipe(Effect.scoped),
    );

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
          stop: () => Effect.void,
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
                    return yield* SessionOperationError.make({
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
          const running = yield* (yield* ChildBackend).launch(request());
          const result = yield* Effect.forkScoped(running.result);
          yield* Effect.forkScoped(
            running.events.pipe(
              Stream.runForEach((event) =>
                event._tag === "SessionIdle" ? Queue.offer(idle, undefined) : Effect.void,
              ),
            ),
          );
          const refused = yield* Effect.flip(running.intervene(Interrupt.make(), noDelivery));
          assert.strictEqual(refused._tag, "SessionOperationError");
          yield* running.intervene(Interrupt.make(), noDelivery);
          assert.strictEqual(calls.filter(({ method }) => method === "turn/interrupt").length, 2);
          yield* Queue.offer(notifications, {
            method: "turn/completed",
            params: { turn: { id: "turn-1", status: "interrupted", error: null } },
          });
          yield* Queue.take(idle);
          assert.strictEqual(result.pollUnsafe(), undefined);
          assert.strictEqual(closes, 0);
          yield* running.intervene(
            OperatorMessage.make({ message: "Continue with my correction" }),
            noDelivery,
          );
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
          yield* running.intervene(Release.make(), noDelivery);
          assert.strictEqual((yield* Fiber.join(result)).message, "Corrected result");
          assert.strictEqual(closes, 1);
          assert.strictEqual(calls.filter(({ method }) => method === "thread/start").length, 1);
        }).pipe(Effect.provide(codexChildLayer.pipe(Layer.provideMerge(server))));
      }).pipe(Effect.scoped),
  );
  it.effect(
    "does not resume or report an infrastructure failure after its attempt is released",
    () =>
      Effect.gen(function* () {
        const notifications = yield* Queue.make<
          CodexNotification,
          SessionOperationError | Cause.Done
        >();
        const stopping = yield* Deferred.make<void>();
        const errors: unknown[] = [];
        const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
          if (logLevel.toUpperCase() === "ERROR" || logLevel.toUpperCase() === "WARN")
            errors.push(message);
        });
        let opens = 0;
        let closes = 0;
        const responses: Record<string, Schema.Json> = successfulResponses([
          { id: "gpt-5.6-terra", model: "gpt-5.6-terra" },
        ]);
        const server = Layer.succeed(CodexAppServer)({
          stop: () => Effect.void,
          open: () =>
            Effect.sync(() => {
              opens += 1;
              return {
                notifications: Stream.fromQueue(notifications),
                notify: () => Effect.void,
                close: Effect.sync(() => {
                  closes += 1;
                }),
                request: (_operation, method) => Effect.succeed(responses[method] ?? {}),
              } satisfies CodexConnection;
            }),
        });
        yield* Effect.gen(function* () {
          const running = yield* (yield* ChildBackend).launch(
            request(
              undefined,
              undefined,
              RemoteShell.make({
                ssh: { command: "ssh", args: [] },
                sshEnvironment: {},
                destination: "worker",
              }),
            ),
          );
          yield* Deferred.succeed(stopping, undefined);
          yield* Queue.fail(
            notifications,
            SessionOperationError.make({
              operation: "stream",
              sessionId: Option.some(running.session.id),
              message: "The transport closed during shutdown",
              cause: ChildProcessLost.make({ exitCode: 143, stderrTail: "" }),
            }),
          );
          yield* TestClock.adjust(0);
          yield* running.interrupt;
          assert.strictEqual(opens, 1);
          assert.strictEqual(closes, 0);
          assert.deepStrictEqual(errors, []);
        }).pipe(
          Effect.provide(codexChildLayer.pipe(Layer.provide(server))),
          Effect.provideService(ChildSessionLifecycle, { isStopping: Deferred.isDone(stopping) }),
          Effect.provide(Logger.layer([logger])),
          Effect.scoped,
        );
      }),
  );

  for (const ending of [
    "interrupted",
    "completed",
    "guidance-during-interrupt",
    "retained",
  ] as const) {
    it.effect(`resends unconsumed guidance before the next Codex turn (${ending})`, () =>
      Effect.gen(function* () {
        const notifications = yield* Queue.make<CodexNotification, Cause.Done>();
        const idle = yield* Queue.make<void>();
        const receipts = yield* Queue.make<string>();
        const started = yield* Queue.make<void>();
        const calls: Array<{ method: string; params: Schema.Json }> = [];
        let turns = ending === "retained" ? 1 : 0;
        const old = OperatorMessage.make({ message: "Check the diff" });
        const next = OperatorMessage.make({ message: "Check the tests" });
        const responses: Readonly<Record<string, Schema.Json>> = successfulResponses([
          { id: "gpt-5.6-terra", model: "gpt-5.6-terra" },
        ]);
        const server = Layer.succeed(CodexAppServer)({
          stop: () => Effect.void,
          open: () =>
            Effect.succeed({
              notifications: Stream.fromQueue(notifications),
              notify: () => Effect.void,
              close: Queue.end(notifications),
              request: (_operation, method, params) =>
                Effect.gen(function* () {
                  calls.push({ method, params });
                  if (method === "thread/resume")
                    return {
                      modelProvider: "openai",
                      thread: {
                        id: "thread-1",
                        turns: [{ id: "turn-1", status: "inProgress", items: [] }],
                      },
                    };
                  if (method === "turn/start") {
                    turns += 1;
                    yield* Queue.offer(started, undefined);
                    return { turn: { id: `turn-${turns}` } };
                  }
                  return responses[method] ?? {};
                }),
            }),
        });
        yield* Effect.gen(function* () {
          const original = request();
          const running = yield* (yield* ChildBackend).launch(
            ending === "retained"
              ? ChildRequest.make({
                  ...original,
                  held: true,
                  resume: Option.some(
                    HarnessSession.make({
                      id: HarnessSessionId.make("thread-1"),
                      cwd: original.cwd,
                    }),
                  ),
                  unread: [{ id: old.id, message: old.message }],
                })
              : original,
          );
          if (ending !== "retained") yield* Queue.take(started);
          yield* Effect.forkScoped(
            running.events.pipe(
              Stream.runForEach((event) =>
                event._tag === "SessionIdle" ? Queue.offer(idle, undefined) : Effect.void,
              ),
            ),
          );
          const intervene = (action: OperatorMessage) =>
            running.intervene(action, (state) =>
              Queue.offer(receipts, Option.isSome(state) ? action.id : "unread").pipe(
                Effect.asVoid,
              ),
            );
          if (ending !== "retained") yield* intervene(old);
          if (ending !== "completed" && ending !== "retained")
            yield* running.intervene(Interrupt.make(), noDelivery);
          if (ending === "guidance-during-interrupt") yield* intervene(next);
          yield* Queue.offer(notifications, {
            method: "turn/completed",
            params: {
              turn: {
                id: "turn-1",
                status:
                  ending === "completed" || ending === "retained" ? "completed" : "interrupted",
                error: null,
              },
            },
          });
          if (ending !== "guidance-during-interrupt") {
            yield* Queue.take(idle);
            assert.strictEqual(turns, 1, "unread input alone must not restart a supervised child");
            yield* intervene(next);
          }
          yield* Queue.take(started);
          const inputs = calls.filter(
            ({ method }) => method === "turn/start" || method === "turn/steer",
          );
          assert.deepStrictEqual(
            inputs.map(({ method }) => method),
            ending === "retained"
              ? ["turn/start", "turn/steer"]
              : ["turn/start", "turn/steer", "turn/start", "turn/steer"],
          );
          assert.include(jsonKey(inputs.at(-2)?.params), old.message);
          assert.include(jsonKey(inputs.at(-1)?.params), next.message);
          const earlyReceipts = yield* Queue.clear(receipts);
          assert.deepStrictEqual(earlyReceipts, [], "resubmission does not acknowledge input");
          for (const [index, action] of [old, next].entries()) {
            yield* Queue.offer(notifications, {
              method: "item/started",
              params: {
                threadId: "thread-1",
                turnId: "turn-2",
                item: {
                  type: "userMessage",
                  id: `input-${index}`,
                  content: [{ type: "text", text: action.message, text_elements: [] }],
                },
              },
            });
            const receipt = yield* Queue.take(receipts);
            assert.strictEqual(receipt, action.id);
          }
          yield* Queue.offer(notifications, {
            method: "turn/completed",
            params: { turn: { id: "turn-2", status: "completed", error: null } },
          });
          yield* Queue.take(idle);
          yield* running.intervene(Release.make(), noDelivery);
          yield* running.result;
        }).pipe(
          Effect.provide(codexChildLayer.pipe(Layer.provide(server))),
          Effect.provideService(ChildSessionJournal, {
            started: () => Effect.void,
            prompted: Effect.void,
            continued: () => Effect.void,
            received: () => Effect.void,
            delivered: (id, state) =>
              Queue.offer(receipts, Option.isSome(state) ? id : "unread").pipe(Effect.asVoid),
          }),
        );
      }).pipe(Effect.scoped),
    );
  }

  it.effect("reads a replayed steer of an active reattached turn without sending it again", () =>
    Effect.gen(function* () {
      const notifications = yield* Queue.make<CodexNotification, Cause.Done>();
      const guidance = Steer.make({ message: "Check the diff" });
      const next = OperatorMessage.make({ message: "Run the linter" });
      const item = {
        type: "userMessage",
        id: "guidance",
        clientId: null,
        content: [{ type: "text", text: guidance.message, text_elements: [] }],
      };
      const inputs: Array<{ method: string; params: Schema.Json }> = [];
      const reads: Array<string> = [];
      const idle = yield* Deferred.make<void>();
      const responses: Readonly<Record<string, Schema.Json>> = successfulResponses([
        { id: "gpt-5.6-terra", model: "gpt-5.6-terra" },
      ]);
      const server = Layer.succeed(CodexAppServer)({
        stop: () => Effect.void,
        open: () =>
          Effect.succeed({
            notifications: Stream.fromQueue(notifications),
            notify: () => Effect.void,
            close: Queue.end(notifications),
            request: (_operation, method, params) =>
              Effect.sync(() => {
                if (method === "thread/resume")
                  return {
                    modelProvider: "openai",
                    thread: {
                      id: "thread-1",
                      turns: [{ id: "turn-2", status: "inProgress", items: [item] }],
                    },
                  };
                if (method === "turn/start" || method === "turn/steer")
                  inputs.push({ method, params });
                return responses[method] ?? {};
              }),
          }),
      });
      yield* Queue.offerAll(notifications, [
        { method: "item/started", params: { threadId: "thread-1", turnId: "turn-2", item } },
        {
          method: "turn/completed",
          params: { turn: { id: "turn-2", status: "completed", error: null } },
        },
      ]);
      yield* Effect.gen(function* () {
        const running = yield* (yield* ChildBackend).launch(
          ChildRequest.make({
            ...request(),
            held: true,
            resume: Option.some(
              HarnessSession.make({ id: HarnessSessionId.make("thread-1"), cwd: request().cwd }),
            ),
            unread: [{ id: guidance.id, message: guidance.message }],
          }),
        );
        yield* Effect.forkScoped(
          running.events.pipe(
            Stream.runForEach((event) =>
              event._tag === "SessionIdle" ? Deferred.succeed(idle, undefined) : Effect.void,
            ),
          ),
        );
        yield* Deferred.await(idle);
        yield* running.intervene(next, noDelivery);
        assert.deepStrictEqual(reads, [guidance.id]);
        assert.deepStrictEqual(
          inputs.map(({ method }) => method),
          ["turn/start"],
        );
        assert.include(jsonKey(inputs[0]?.params), next.message);
      }).pipe(
        Effect.provide(codexChildLayer.pipe(Layer.provide(server))),
        Effect.provideService(ChildSessionJournal, {
          started: () => Effect.void,
          prompted: Effect.void,
          continued: () => Effect.void,
          received: () => Effect.void,
          delivered: (id, state) =>
            Effect.sync(() => {
              if (Option.isSome(state)) reads.push(id);
            }),
        }),
      );
    }).pipe(Effect.scoped),
  );

  for (const commit of ["synchronous", "received", "delivered"] as const)
    it.effect(
      `doesn't resend a restored message that the last finished Codex turn read (${commit} commit)`,
      () =>
        Effect.gen(function* () {
          const notifications = yield* Queue.make<CodexNotification, Cause.Done>();
          const read = OperatorMessage.make({ message: "Check the diff" });
          const alsoRead = OperatorMessage.make({ message: "Check the tests" });
          const unread = OperatorMessage.make({ message: "Run the linter" });
          const inputs: Array<{ method: string; params: Schema.Json }> = [];
          const deliveries: Array<string> = [];
          const saved = HarnessSession.make({
            id: HarnessSessionId.make("thread-1"),
            cwd: request().cwd,
          });
          const userMessage = (id: string, text: string) => ({
            type: "userMessage",
            id,
            content: [{ type: "text", text, text_elements: [] }],
          });
          const items = [
            userMessage("guidance-1", read.message),
            userMessage("guidance-2", alsoRead.message),
          ];
          if (commit !== "synchronous") {
            yield* Queue.offerAll(notifications, [
              ...items.map((item) => ({
                method: "item/started",
                params: { threadId: saved.id, turnId: "turn-2", item },
              })),
              {
                method: "turn/completed",
                params: { threadId: saved.id, turn: { id: "turn-2", status: "completed", items } },
              },
            ]);
          }
          const responses = new Map(
            Object.entries({
              ...successfulResponses([{ id: "gpt-5.6-terra", model: "gpt-5.6-terra" }]),
              "thread/resume": {
                modelProvider: "openai",
                thread: {
                  id: saved.id,
                  turns: [
                    {
                      id: "turn-1",
                      status: "completed",
                      items: [userMessage("task", request().prompt)],
                    },
                    {
                      id: "turn-2",
                      status: "completed",
                      items,
                    },
                  ],
                },
              },
            }),
          );
          const server = Layer.succeed(CodexAppServer)({
            stop: () => Effect.void,
            open: () =>
              Effect.succeed({
                notifications: Stream.fromQueue(notifications),
                notify: () => Effect.void,
                close: Queue.end(notifications).pipe(Effect.asVoid),
                request: (_operation, method, params) =>
                  Effect.sync(() => {
                    if (method === "turn/start" || method === "turn/steer")
                      inputs.push({ method, params });
                    return responses.get(method) ?? {};
                  }),
              }),
          });
          yield* Effect.gen(function* () {
            yield* (yield* ChildBackend).launch(
              ChildRequest.make({
                ...request(),
                resume: Option.some(saved),
                unread: [
                  { id: read.id, message: read.message },
                  { id: alsoRead.id, message: alsoRead.message },
                  { id: unread.id, message: unread.message },
                ],
              }),
            );
            assert.deepStrictEqual(deliveries, [`read ${read.id}`, `read ${alsoRead.id}`]);
            assert.deepStrictEqual(
              inputs.map(({ method }) => method),
              ["turn/start", "turn/steer"],
            );
            assert.include(jsonKey(inputs[0]?.params), CONTINUATION_MESSAGE);
            assert.include(jsonKey(inputs[1]?.params), unread.message);
          }).pipe(
            Effect.provide(codexChildLayer.pipe(Layer.provide(server))),
            Effect.provideService(ChildSessionJournal, {
              started: () => Effect.void,
              prompted: Effect.void,
              continued: () => Effect.void,
              received: () => (commit === "received" ? Effect.yieldNow : Effect.void),
              delivered: (id, state) =>
                Effect.sync(() => {
                  deliveries.push(`${Option.isSome(state) ? "read" : "unread"} ${id}`);
                }).pipe(Effect.andThen(commit === "delivered" ? Effect.yieldNow : Effect.void)),
            }),
          );
        }).pipe(Effect.scoped),
    );

  it.effect("sends a restored message whose text a saved receipt already acknowledged", () =>
    Effect.gen(function* () {
      const logs = collectLogs(["Info"]);
      const notifications = yield* Queue.make<CodexNotification, Cause.Done>();
      const repeated = OperatorMessage.make({ message: "Check the tests" });
      const task = OperatorMessage.make({ message: request().prompt });
      const inputs: Array<{ method: string; params: Schema.Json }> = [];
      const journal: Array<string> = [];
      const read = yield* Deferred.make<void>();
      const saved = HarnessSession.make({
        id: HarnessSessionId.make("thread-1"),
        cwd: request().cwd,
      });
      const userMessage = (id: string, text: string) => ({
        type: "userMessage",
        id,
        content: [{ type: "text", text, text_elements: [] }],
      });
      const responses = new Map(
        Object.entries({
          ...successfulResponses([{ id: "gpt-5.6-terra", model: "gpt-5.6-terra" }]),
          "turn/start": { turn: { id: "turn-2" } },
          "thread/resume": {
            modelProvider: "openai",
            thread: {
              id: saved.id,
              turns: [
                {
                  id: "turn-1",
                  status: "completed",
                  items: [
                    userMessage("task", request().prompt),
                    userMessage("guidance", repeated.message),
                  ],
                },
              ],
            },
          },
        }),
      );
      const server = Layer.succeed(CodexAppServer)({
        stop: () => Effect.void,
        open: () =>
          Effect.succeed({
            notifications: Stream.fromQueue(notifications),
            notify: () => Effect.void,
            close: Queue.end(notifications).pipe(Effect.asVoid),
            request: (_operation, method, params) =>
              Effect.sync(() => {
                if (method === "turn/start" || method === "turn/steer")
                  inputs.push({ method, params });
                return responses.get(method) ?? {};
              }),
          }),
      });
      yield* Effect.gen(function* () {
        yield* (yield* ChildBackend).launch(
          ChildRequest.make({
            ...request(),
            resume: Option.some(saved),
            receipts: Option.some(["task", "guidance"]),
            unread: [
              { id: repeated.id, message: repeated.message },
              { id: task.id, message: task.message },
            ],
          }),
        );
        assert.deepStrictEqual(journal, [], "the saved items acknowledged earlier input");
        assert.deepStrictEqual(
          logs.records.flatMap(({ message }) =>
            Array.isArray(message) && message[0] === "Checked restored Codex user-message receipts"
              ? [message[1]]
              : [],
          ),
          [{ sessionId: request().session.id, turnId: "turn-1", skipped: 2, read: 0, unread: 2 }],
        );
        assert.deepStrictEqual(
          inputs.map(({ method }) => method),
          ["turn/start", "turn/steer", "turn/steer"],
        );
        assert.include(jsonKey(inputs[0]?.params), CONTINUATION_MESSAGE);
        assert.include(jsonKey(inputs[1]?.params), repeated.message);
        assert.include(jsonKey(inputs[2]?.params), task.message);
        yield* Queue.offer(notifications, {
          method: "item/started",
          params: {
            threadId: saved.id,
            turnId: "turn-2",
            item: { ...userMessage("guidance-2", repeated.message), clientId: null },
          },
        });
        yield* Deferred.await(read);
        assert.deepStrictEqual(journal, ["received guidance-2", `read ${repeated.id}`]);
      }).pipe(
        Effect.provide(codexChildLayer.pipe(Layer.provide(server), Layer.provideMerge(logs.layer))),
        Effect.provideService(ChildSessionJournal, {
          started: () => Effect.void,
          prompted: Effect.void,
          continued: () => Effect.void,
          received: (items) =>
            Effect.sync(() => {
              journal.push(`received ${items.join(" ")}`);
            }),
          delivered: (id, state) =>
            Effect.sync(() => {
              journal.push(`${Option.isSome(state) ? "read" : "unread"} ${id}`);
            }).pipe(Effect.andThen(Deferred.succeed(read, undefined)), Effect.asVoid),
        }),
      );
    }).pipe(Effect.scoped),
  );

  describe("saved receipts", () => {
    const userMessage = (id: string, text: string) => ({
      type: "userMessage",
      id,
      content: [{ type: "text", text, text_elements: [] }],
    });
    const saved = HarnessSession.make({
      id: HarnessSessionId.make("thread-1"),
      cwd: request().cwd,
    });
    /** A Codex app-server whose saved thread ends with turn `turn-1` holding `items`. */
    const appServer = (
      notifications: Queue.Queue<CodexNotification, Cause.Done>,
      items: ReadonlyArray<Schema.Json>,
      inputs: Array<{ method: string; params: Schema.Json }>,
    ) => {
      const responses = new Map(
        Object.entries({
          ...successfulResponses([{ id: "gpt-5.6-terra", model: "gpt-5.6-terra" }]),
          "thread/resume": {
            modelProvider: "openai",
            thread: { id: saved.id, turns: [{ id: "turn-1", status: "completed", items }] },
          },
        }),
      );
      return Layer.succeed(CodexAppServer)({
        stop: () => Effect.void,
        open: () =>
          Effect.succeed({
            notifications: Stream.fromQueue(notifications),
            notify: () => Effect.void,
            close: Queue.end(notifications).pipe(Effect.asVoid),
            request: (_operation, method, params) =>
              Effect.sync(() => {
                if (method === "turn/start" || method === "turn/steer")
                  inputs.push({ method, params });
                return responses.get(method) ?? {};
              }),
          }),
      });
    };
    /** A journal that records the saved receipts and the messages reported read. */
    const recording = (
      received: Array<ReadonlyArray<string>>,
      reads: Array<string>,
      saves?: Queue.Queue<void>,
    ) =>
      Effect.provideService(ChildSessionJournal, {
        started: () => Effect.void,
        prompted: Effect.void,
        continued: () => Effect.void,
        received: (items) =>
          Effect.sync(() => {
            received.push([...items]);
          }).pipe(
            Effect.andThen(saves === undefined ? Effect.void : Queue.offer(saves, undefined)),
            Effect.asVoid,
          ),
        delivered: (id, state) =>
          Effect.sync(() => {
            if (Option.isSome(state)) reads.push(id);
          }),
      });

    it.effect("resends repeated guidance when the delegation predates saved receipts", () =>
      Effect.gen(function* () {
        const repeated = OperatorMessage.make({ message: "Check the tests" });
        const items = [
          userMessage("task", request().prompt),
          userMessage("guidance", repeated.message),
        ];
        const received: Array<ReadonlyArray<string>> = [];
        for (const receipts of [
          Option.none<ReadonlyArray<string>>(),
          Option.some(["task", "guidance"]),
        ]) {
          const notifications = yield* Queue.make<CodexNotification, Cause.Done>();
          const reads: Array<string> = [];
          const inputs: Array<{ method: string; params: Schema.Json }> = [];
          yield* Effect.gen(function* () {
            yield* (yield* ChildBackend).launch(
              ChildRequest.make({
                ...request(),
                resume: Option.some(saved),
                receipts,
                unread: [{ id: repeated.id, message: repeated.message }],
              }),
            );
            assert.deepStrictEqual(reads, []);
            assert.deepStrictEqual(
              inputs.map(({ method }) => method),
              ["turn/start", "turn/steer"],
            );
            assert.include(jsonKey(inputs[1]?.params), repeated.message);
          }).pipe(
            Effect.scoped,
            Effect.provide(
              codexChildLayer.pipe(Layer.provide(appServer(notifications, items, inputs))),
            ),
            recording(received, reads),
          );
        }
        assert.deepStrictEqual(received, [["task", "guidance"]]);
      }).pipe(Effect.scoped),
    );

    for (const recovery of ["repeated guidance", "new guidance"] as const)
      it.effect(`matches ${recovery} after an older delegation loses its app-server`, () =>
        Effect.gen(function* () {
          const original = yield* Queue.make<
            CodexNotification,
            SessionOperationError | Cause.Done
          >();
          const restored = yield* Queue.make<CodexNotification, Cause.Done>();
          const recovered = yield* Deferred.make<void>();
          const repeated = OperatorMessage.make({ message: "Check the tests" });
          const guidance = Steer.make({ message: "Run the linter" });
          const items = [
            userMessage("task", request().prompt),
            userMessage("guidance", repeated.message),
          ];
          const inputs: Array<{ method: string; params: Schema.Json }> = [];
          const received: Array<ReadonlyArray<string>> = [];
          const reads: Array<string> = [];
          const responses: Readonly<Record<string, Schema.Json>> = successfulResponses([
            { id: "gpt-5.6-terra", model: "gpt-5.6-terra" },
          ]);
          let opens = 0;
          let turn = 1;
          const server = Layer.succeed(CodexAppServer)({
            stop: () => Effect.void,
            open: () =>
              Effect.sync(() => {
                const first = opens++ === 0;
                return {
                  notifications: first
                    ? Stream.fromQueue(original)
                    : Stream.unwrap(
                        Deferred.succeed(recovered, undefined).pipe(
                          Effect.as(Stream.fromQueue(restored)),
                        ),
                      ),
                  notify: () => Effect.void,
                  close: Queue.end(restored),
                  request: (_operation, method, params) =>
                    Effect.sync(() => {
                      if (method === "turn/start" || method === "turn/steer")
                        inputs.push({ method, params });
                      if (method === "turn/start") return { turn: { id: `turn-${++turn}` } };
                      if (method === "thread/resume")
                        return {
                          modelProvider: "openai",
                          thread: {
                            id: saved.id,
                            turns: [
                              { id: "turn-1", status: "completed", items },
                              ...(!first && recovery === "new guidance"
                                ? [
                                    {
                                      id: "turn-2",
                                      status: "completed",
                                      items: [userMessage("new-guidance", guidance.message)],
                                    },
                                  ]
                                : []),
                            ],
                          },
                        };
                      return responses[method] ?? {};
                    }),
                } satisfies CodexConnection;
              }),
          });
          yield* Effect.gen(function* () {
            const host = RemoteShell.make({
              ssh: { command: "ssh", args: [] },
              sshEnvironment: {},
              destination: "worker",
            });
            const running = yield* (yield* ChildBackend).launch(
              ChildRequest.make({
                ...request(undefined, undefined, host),
                resume: Option.some(saved),
                held: true,
                receipts: Option.none(),
                unread:
                  recovery === "repeated guidance"
                    ? [{ id: repeated.id, message: repeated.message }]
                    : [],
              }),
            );
            assert.deepStrictEqual(received, [["task", "guidance"]]);
            assert.deepStrictEqual(reads, []);
            assert.deepStrictEqual(inputs, []);
            if (recovery === "new guidance")
              yield* running.intervene(guidance, (state) =>
                Effect.sync(() => {
                  if (Option.isSome(state)) reads.push(guidance.id);
                }),
              );
            yield* Queue.fail(
              original,
              SessionOperationError.make({
                operation: "stream",
                sessionId: Option.some(running.session.id),
                message: "App-server exited",
                cause: ChildProcessLost.make({ exitCode: 1, stderrTail: "App-server exited" }),
              }),
            );
            yield* Deferred.await(recovered);
            assert.strictEqual(opens, 2);
            assert.deepStrictEqual(reads, recovery === "repeated guidance" ? [] : [guidance.id]);
            const before = inputs.length;
            yield* running.intervene(OperatorMessage.make({ message: "Continue" }), noDelivery);
            const resumed = inputs.slice(before);
            assert.deepStrictEqual(
              resumed.map(({ method }) => method),
              recovery === "repeated guidance" ? ["turn/start", "turn/steer"] : ["turn/start"],
            );
            if (recovery === "repeated guidance")
              assert.include(jsonKey(resumed[0]?.params), repeated.message);
            else assert.notInclude(jsonKey(resumed), guidance.message);
          }).pipe(
            Effect.provide(codexChildLayer.pipe(Layer.provide(server))),
            recording(received, reads),
          );
        }).pipe(Effect.scoped),
      );

    it.effect(
      "does not count restored reads as an operator answer in the held placeholder report",
      () =>
        Effect.gen(function* () {
          const notifications = yield* Queue.make<CodexNotification, Cause.Done>();
          const guidance = OperatorMessage.make({ message: "Check the diff" });
          const items = [
            userMessage("guidance", guidance.message),
            { type: "commandExecution", id: "command", command: "git diff", status: "completed" },
            { type: "agentMessage", id: "answer", text: "Checked the diff" },
          ];
          const inputs: Array<{ method: string; params: Schema.Json }> = [];
          const reads: Array<string> = [];
          yield* Effect.gen(function* () {
            const running = yield* (yield* ChildBackend).launch(
              ChildRequest.make({
                ...request(),
                resume: Option.some(saved),
                held: true,
                unread: [{ id: guidance.id, message: guidance.message }],
              }),
            );
            const idle = yield* running.events.pipe(
              Stream.filter((event) => event._tag === "SessionIdle"),
              Stream.take(1),
              Stream.runCollect,
            );
            assert.deepStrictEqual(reads, [guidance.id]);
            assert.strictEqual(idle[0]?.answeredOperator, false);
            assert.deepStrictEqual(inputs, []);
            yield* running.intervene(Release.make(), noDelivery);
            const result = yield* running.result;
            assert.strictEqual(result.message, "Session interrupted before its turn returned");
            assert.isFalse(result.answeredOperator);
          }).pipe(
            Effect.provide(
              codexChildLayer.pipe(Layer.provide(appServer(notifications, items, inputs))),
            ),
            recording([], reads),
          );
        }).pipe(Effect.scoped),
    );

    it.effect("saves every user-message item that one Codex turn observed", () =>
      Effect.gen(function* () {
        const notifications = yield* Queue.make<CodexNotification, Cause.Done>();
        const repeated = OperatorMessage.make({ message: "Check the tests" });
        const items = [
          userMessage("task", request().prompt),
          userMessage("g1", repeated.message),
          userMessage("g2", "Run the linter"),
        ];
        const received: Array<ReadonlyArray<string>> = [];
        const reads: Array<string> = [];
        const saves = yield* Queue.make<void>();
        yield* Effect.gen(function* () {
          yield* (yield* ChildBackend).launch(request());
          yield* Queue.offerAll(
            notifications,
            items.map((item) => ({
              method: "item/started",
              params: { threadId: "thread-1", turnId: "turn-1", item: { ...item, clientId: null } },
            })),
          );
          yield* Queue.takeN(saves, items.length);
        }).pipe(
          Effect.provide(codexChildLayer.pipe(Layer.provide(appServer(notifications, [], [])))),
          recording(received, reads, saves),
        );
        assert.deepStrictEqual(received.at(-1), ["task", "g1", "g2"]);

        // A restart with the saved list doesn't match the earlier item to a repeated message.
        const restarted = yield* Queue.make<CodexNotification, Cause.Done>();
        const inputs: Array<{ method: string; params: Schema.Json }> = [];
        yield* Effect.gen(function* () {
          yield* (yield* ChildBackend).launch(
            ChildRequest.make({
              ...request(),
              resume: Option.some(saved),
              receipts: Option.some(received.at(-1) ?? []),
              unread: [{ id: repeated.id, message: repeated.message }],
            }),
          );
        }).pipe(
          Effect.provide(codexChildLayer.pipe(Layer.provide(appServer(restarted, items, inputs)))),
          recording([], reads),
        );
        assert.deepStrictEqual(reads, []);
        assert.deepStrictEqual(
          inputs.map(({ method }) => method),
          ["turn/start", "turn/steer"],
        );
        assert.include(jsonKey(inputs[1]?.params), repeated.message);
      }).pipe(Effect.scoped),
    );

    it.effect("keeps the restored receipts when a reattached Codex turn records another item", () =>
      Effect.gen(function* () {
        const repeated = OperatorMessage.make({ message: "Check the tests" });
        const items = [
          userMessage("task", request().prompt),
          userMessage("g1", repeated.message),
          userMessage("g3", "Run the linter"),
        ];
        // A held idle child resumes without a turn, so each restart only reads the last turn.
        const restart = (receipts: ReadonlyArray<string>, unread: ReadonlyArray<OperatorMessage>) =>
          Effect.gen(function* () {
            const notifications = yield* Queue.make<CodexNotification, Cause.Done>();
            const received: Array<ReadonlyArray<string>> = [];
            const reads: Array<string> = [];
            const inputs: Array<{ method: string; params: Schema.Json }> = [];
            yield* Effect.gen(function* () {
              yield* (yield* ChildBackend).launch(
                ChildRequest.make({
                  ...request(),
                  resume: Option.some(saved),
                  held: true,
                  idle: Option.some("Saved final report."),
                  receipts: Option.some(receipts),
                  unread: unread.map(({ id, message }) => ({ id, message })),
                }),
              );
            }).pipe(
              Effect.provide(
                codexChildLayer.pipe(Layer.provide(appServer(notifications, items, inputs))),
              ),
              recording(received, reads),
            );
            assert.deepStrictEqual(inputs, []);
            return { received, reads };
          });
        const first = yield* restart(["task", "g1"], []);
        assert.deepStrictEqual(first.received, [["task", "g1", "g3"]]);
        const second = yield* restart(first.received.at(-1) ?? [], [repeated]);
        assert.deepStrictEqual(second, { received: [], reads: [] });
      }).pipe(Effect.scoped),
    );
  });

  it.effect("doesn't resend guidance that the lost Codex app-server's turn read", () =>
    Effect.gen(function* () {
      const original = yield* Queue.make<CodexNotification, SessionOperationError | Cause.Done>();
      const restored = yield* Queue.make<CodexNotification, Cause.Done>();
      const recovered = yield* Deferred.make<void>();
      const guidance = "Check the final diff too.";
      const responses: Readonly<Record<string, Schema.Json>> = successfulResponses([
        { id: "gpt-5.6-terra", model: "gpt-5.6-terra" },
      ]);
      const submitted: Array<{ method: string; params: Schema.Json }> = [];
      const reads: Array<Option.Option<InterventionState>> = [];
      const userMessage = (id: string, text: string) => ({
        type: "userMessage",
        id,
        content: [{ type: "text", text, text_elements: [] }],
      });
      let opens = 0;
      let turns = 0;
      const server = Layer.succeed(CodexAppServer)({
        stop: () => Effect.void,
        open: () =>
          Effect.sync(
            () =>
              ({
                notifications:
                  opens++ === 0
                    ? Stream.fromQueue(original)
                    : Stream.unwrap(
                        Deferred.succeed(recovered, undefined).pipe(
                          Effect.as(Stream.fromQueue(restored)),
                        ),
                      ),
                notify: () => Effect.void,
                close: Queue.end(restored),
                request: (_operation, method, params) =>
                  Effect.sync(() => {
                    if (method === "turn/start" || method === "turn/steer")
                      submitted.push({ method, params });
                    if (method === "turn/start") return { turn: { id: `turn-${++turns}` } };
                    if (method === "thread/resume")
                      return {
                        modelProvider: "openai",
                        thread: {
                          id: "thread-1",
                          turns: [
                            {
                              id: "turn-1",
                              status: "completed",
                              items: [
                                userMessage("task", request().prompt),
                                userMessage("guidance", guidance),
                              ],
                            },
                          ],
                        },
                      };
                    return responses[method] ?? {};
                  }),
              }) satisfies CodexConnection,
          ),
      });
      yield* Effect.gen(function* () {
        const host = RemoteShell.make({
          ssh: { command: "ssh", args: [] },
          sshEnvironment: {},
          destination: "worker",
        });
        const running = yield* (yield* ChildBackend).launch(request(undefined, undefined, host));
        const taken = yield* running.intervene(Steer.make({ message: guidance }), (delivered) =>
          Effect.sync(() => {
            reads.push(delivered);
          }),
        );
        assert.isTrue(taken.queued);
        const before = submitted.length;
        yield* Queue.fail(
          original,
          SessionOperationError.make({
            operation: "stream",
            sessionId: Option.some(running.session.id),
            message: "App-server exited",
            cause: ChildProcessLost.make({ exitCode: 1, stderrTail: "App-server exited" }),
          }),
        );
        yield* Deferred.await(recovered);
        assert.lengthOf(reads, 1, "the restored turn read the guidance");
        assert(reads.every(Option.isSome));
        assert.deepStrictEqual(
          submitted.slice(before).map(({ method }) => method),
          ["turn/start"],
          "only the continuation",
        );
        assert.include(jsonKey(submitted[before]?.params), CONTINUATION_MESSAGE);
        assert.strictEqual(opens, 2);
      }).pipe(Effect.provide(codexChildLayer.pipe(Layer.provideMerge(server))));
    }).pipe(Effect.scoped),
  );

  it.effect("starts one Codex turn when guidance arrives while a turn starts", () =>
    Effect.gen(function* () {
      const notifications = yield* Queue.make<CodexNotification, Cause.Done>();
      const starting = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const inputs: Array<{ method: string; params: Schema.Json }> = [];
      let starts = 0;
      const responses: Readonly<Record<string, Schema.Json>> = successfulResponses([
        { id: "gpt-5.6-terra", model: "gpt-5.6-terra" },
      ]);
      const server = Layer.succeed(CodexAppServer)({
        stop: () => Effect.void,
        open: () =>
          Effect.succeed({
            notifications: Stream.fromQueue(notifications),
            notify: () => Effect.void,
            close: Queue.end(notifications).pipe(Effect.asVoid),
            request: (_operation, method, params) =>
              Effect.gen(function* () {
                if (method === "turn/start" || method === "turn/steer")
                  inputs.push({ method, params });
                if (method !== "turn/start") return responses[method] ?? {};
                starts += 1;
                const turn = starts;
                if (turn === 2) {
                  yield* Deferred.succeed(starting, undefined);
                  yield* Deferred.await(gate);
                }
                return { turn: { id: `turn-${turn}` } };
              }),
          }),
      });
      yield* Effect.gen(function* () {
        const running = yield* (yield* ChildBackend).launch(request());
        yield* running.intervene(Interrupt.make(), noDelivery);
        yield* running.intervene(Steer.make({ message: "Check the diff" }), noDelivery);
        yield* Queue.offer(notifications, {
          method: "turn/completed",
          params: { turn: { id: "turn-1", status: "interrupted", error: null } },
        });
        yield* Deferred.await(starting);
        const guidance = yield* Effect.forkScoped(
          running.intervene(OperatorMessage.make({ message: "Check the tests" }), noDelivery),
        );
        for (let spin = 0; spin < 100; spin += 1) yield* Effect.yieldNow;
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(guidance);
        assert.deepStrictEqual(
          inputs.map(({ method }) => method),
          ["turn/start", "turn/start", "turn/steer"],
        );
        assert.include(jsonKey(inputs[1]?.params), "Check the diff");
        assert.include(jsonKey(inputs[2]?.params), "Check the tests");
        assert.include(jsonKey(inputs[2]?.params), "turn-2");
      }).pipe(Effect.provide(codexChildLayer.pipe(Layer.provide(server))));
    }).pipe(Effect.scoped),
  );

  for (const state of ["working", "queued", "paused", "interrupting", "idle"] as const) {
    it.effect(`preserves unread guidance and ${state} state after app-server recovery`, () =>
      Effect.gen(function* () {
        const original = yield* Queue.make<CodexNotification, SessionOperationError | Cause.Done>();
        const restored = yield* Queue.make<CodexNotification, Cause.Done>();
        const idle = yield* Queue.make<void>();
        const recovered = yield* Deferred.make<void>();
        const receipts = yield* Queue.make<void>();
        const responses: Readonly<Record<string, Schema.Json>> = successfulResponses([
          { id: "gpt-5.6-terra", model: "gpt-5.6-terra" },
        ]);
        const submitted: Array<{ method: string; params: Schema.Json }> = [];
        const guidance = "Check the final diff too.";
        const reads: Array<Option.Option<InterventionState>> = [];
        let opens = 0;
        let turns = 0;
        const server = Layer.succeed(CodexAppServer)({
          stop: () => Effect.void,
          open: () =>
            Effect.sync(
              () =>
                ({
                  notifications:
                    opens++ === 0
                      ? Stream.fromQueue(original)
                      : Stream.unwrap(
                          Deferred.succeed(recovered, undefined).pipe(
                            Effect.as(Stream.fromQueue(restored)),
                          ),
                        ),
                  notify: () => Effect.void,
                  close: Queue.end(restored),
                  request: (_operation, method, params) =>
                    Effect.sync(() => {
                      if (method === "turn/start" || method === "turn/steer")
                        submitted.push({ method, params });
                      if (method === "turn/start") return { turn: { id: `turn-${++turns}` } };
                      if (method === "thread/resume")
                        return {
                          modelProvider: "openai",
                          thread: {
                            id: "thread-1",
                            turns: [{ id: "turn-1", status: "completed", items: [] }],
                          },
                        };
                      return responses[method] ?? {};
                    }),
                }) satisfies CodexConnection,
            ),
        });
        yield* Effect.gen(function* () {
          const host = RemoteShell.make({
            ssh: { command: "ssh", args: [] },
            sshEnvironment: {},
            destination: "worker",
          });
          const running = yield* (yield* ChildBackend).launch(request(undefined, undefined, host));
          const result = yield* Effect.forkScoped(running.result);
          yield* Effect.forkScoped(
            running.events.pipe(
              Stream.runForEach((event) =>
                event._tag === "SessionIdle" ? Queue.offer(idle, undefined) : Effect.void,
              ),
            ),
          );
          if (state === "queued") yield* running.intervene(Interrupt.make(), noDelivery);
          for (let index = 0; index < 2; index++) {
            const action =
              state === "idle"
                ? OperatorMessage.make({ message: guidance })
                : Steer.make({ message: guidance });
            const taken = yield* running.intervene(action, (delivered) =>
              Effect.sync(() => {
                reads.push(delivered);
              }).pipe(Effect.andThen(Queue.offer(receipts, undefined)), Effect.asVoid),
            );
            assert.isTrue(taken.queued);
          }
          if (state === "paused" || state === "interrupting")
            yield* running.intervene(Interrupt.make(), noDelivery);
          if (state === "paused" || state === "idle") {
            yield* Queue.offer(original, {
              method: "turn/completed",
              params: {
                turn: {
                  id: "turn-1",
                  status: state === "idle" ? "completed" : "interrupted",
                  error: null,
                },
              },
            });
            yield* Queue.take(idle);
          }
          const before = submitted.length;
          yield* Queue.fail(
            original,
            SessionOperationError.make({
              operation: "stream",
              sessionId: Option.some(running.session.id),
              message: "App-server exited",
              cause: ChildProcessLost.make({ exitCode: 1, stderrTail: "App-server exited" }),
            }),
          );
          yield* Deferred.await(recovered);
          if (state === "interrupting") yield* Queue.take(idle);
          assert.lengthOf(reads, 0, "neither a turn ending nor resubmission acknowledges input");
          if (state === "working" || state === "queued") {
            assert.lengthOf(
              submitted.slice(before),
              3,
              "one continuation and both unread messages",
            );
            assert.include(jsonKey(submitted[before]?.params), CONTINUATION_MESSAGE);
          } else {
            assert.lengthOf(submitted, before, "supervised children get no recovery turn");
            yield* running.intervene(
              OperatorMessage.make({ message: "Continue with my correction" }),
              noDelivery,
            );
            assert.lengthOf(submitted.slice(before), 3, "old guidance precedes the new correction");
          }
          const echo = (id: string) =>
            Queue.offer(restored, {
              method: "item/started",
              params: {
                threadId: "thread-1",
                turnId: "turn-2",
                item: {
                  type: "userMessage",
                  id,
                  clientId: null,
                  content: [{ type: "text", text: guidance, text_elements: [] }],
                },
              },
            });
          yield* echo("guidance-1");
          yield* Queue.take(receipts);
          yield* echo("guidance-1");
          yield* echo("guidance-2");
          yield* Queue.take(receipts);
          yield* Queue.offer(restored, {
            method: "item/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-2",
              item: { type: "agentMessage", id: "answer", text: "Corrected result" },
            },
          });
          yield* Queue.offer(restored, {
            method: "turn/completed",
            params: { turn: { id: "turn-2", status: "completed", error: null } },
          });
          if (state !== "working" && state !== "queued") {
            yield* Queue.take(idle);
            yield* running.intervene(Release.make(), noDelivery);
          }
          assert.strictEqual((yield* Fiber.join(result)).message, "Corrected result");
          assert.lengthOf(
            reads,
            2,
            "a repeated native item cannot acknowledge the second identical input",
          );
          assert(reads.every(Option.isSome));
          assert.strictEqual(opens, 2);
        }).pipe(Effect.provide(codexChildLayer.pipe(Layer.provideMerge(server))));
      }).pipe(Effect.scoped),
    );
  }

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
            const backend = yield* ChildBackend;
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
              const matchesOutcomeFailure = Schema.is(AgentResultError)(outcome.failure);
              assert(matchesOutcomeFailure);
            }
          }).pipe(
            Effect.ensuring(Deferred.succeed(closed, undefined)),
            Effect.provide(codexChildLayer.pipe(Layer.provideMerge(server))),
          ),
        );
      }),
    );
  }

  it.effect("normalizes completed messages, tools, and ChatGPT rate windows", () => {
    const calls: Array<{ readonly method: string; readonly params: Schema.Json }> = [];
    const startedTool = {
      type: "commandExecution",
      id: "tool-1",
      status: "inProgress",
      command: "ls -la",
      cwd: "/repo",
    };
    const finishedTool = {
      ...startedTool,
      status: "completed",
      aggregatedOutput: "total 0",
      exitCode: 0,
    };
    const notifications: ReadonlyArray<CodexNotification> = [
      {
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId: "turn-1", delta: "do not emit" },
      },
      {
        method: "item/started",
        params: { threadId: "thread-1", turnId: "turn-1", item: startedTool },
      },
      {
        method: "item/completed",
        params: { threadId: "thread-1", turnId: "turn-1", item: finishedTool },
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
        const backend = yield* ChildBackend;
        const running = yield* backend.launch(request());
        assert.deepStrictEqual(
          clients.map(({ environment, host }) => [environment, host]),
          [[request().environment, LocalProcess.make()]],
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
        const toolStarted = events.find((event) => event._tag === "ToolStarted");
        assert(toolStarted?._tag === "ToolStarted");
        assert.deepStrictEqual(toolStarted.input, startedTool);
        const toolFinished = events.find((event) => event._tag === "ToolFinished");
        assert(toolFinished?._tag === "ToolFinished");
        assert.deepStrictEqual(toolFinished.output, finishedTool);
        const limits = events.find((event) => event._tag === "PoolRateLimitsUpdated");
        assert(limits?._tag === "PoolRateLimitsUpdated");
        assert.strictEqual(Option.getOrNull(limits.login), "operator@example.com");
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
        assert.deepStrictEqual(
          started.harnessSession.value.home,
          Option.some("/home/worker/.codex"),
        );
        const turn = calls.find(({ method }) => method === "turn/start")?.params;
        assert(Schema.is(Schema.Struct({ effort: Schema.String }))(turn));
        assert.strictEqual(turn.effort, "none");
        assert(calls.some(({ method }) => method === "turn/steer"));
        assert(calls.some(({ method }) => method === "turn/interrupt"));
      }).pipe(Effect.provide(codexChildLayer.pipe(Layer.provideMerge(server)))),
    );
  });

  it.effect(
    "reports each provider reconnect of a turn and the recovery when the turn resumes",
    () => {
      // App-server notifications from a Worker whose gateway could not resolve chatgpt.com (#266).
      const reconnect = (message: string, additionalDetails: string, turnId = "turn-1") => ({
        method: "error",
        params: {
          error: { message, codexErrorInfo: null, additionalDetails },
          willRetry: true,
          threadId: "thread-1",
          turnId,
        },
      });
      const notifications: ReadonlyArray<CodexNotification> = [
        reconnect("Reconnecting... 1/5", "request timed out"),
        reconnect(
          "Reconnecting... waiting for network",
          "Connection failed: error sending request",
        ),
        reconnect("Reconnecting... 1/5", "request timed out", "turn-0"),
        {
          method: "error",
          params: {
            error: {
              message: "Usage limit reached",
              codexErrorInfo: null,
              additionalDetails: null,
            },
            willRetry: false,
            threadId: "thread-1",
            turnId: "turn-1",
          },
        },
        {
          method: "item/agentMessage/delta",
          params: { threadId: "thread-1", turnId: "turn-1", itemId: "m-1", delta: "Do" },
        },
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
      const warnings: Array<string> = [];
      const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
        if (logLevel === "Warn") warnings.push(jsonKey(message));
      });
      const server = connectionLayer(
        successfulResponses([{ id: "gpt-5.6-terra", model: "gpt-5.6-terra" }]),
        notifications,
      );
      return Effect.scoped(
        Effect.gen(function* () {
          const running = yield* (yield* ChildBackend).launch(request());
          const [events, result] = yield* Effect.all([
            Stream.runCollect(running.events),
            running.result,
          ]);
          assert.strictEqual(result.message, "Done.");
          assert.deepStrictEqual(
            events.map((event) => event._tag),
            [
              "SessionStarted",
              "ProviderRetrying",
              "ProviderRetrying",
              "ProviderRecovered",
              "TextOutput",
              "SessionFinished",
            ],
          );
          const reports = events.filter((event) => event._tag === "ProviderRetrying");
          assert.deepStrictEqual(
            reports.map(({ message, retries }) => [message, retries]),
            [
              ["Reconnecting... 1/5 (request timed out)", 1],
              ["Reconnecting... waiting for network (Connection failed: error sending request)", 2],
            ],
          );
          const recovered = events.find((event) => event._tag === "ProviderRecovered");
          assert(recovered?._tag === "ProviderRecovered");
          assert.strictEqual(recovered.retries, 2);
          const reconnects = warnings.filter((line) => line.includes("cannot reach its provider"));
          assert.lengthOf(reconnects, 2, "one warning per reconnect of the current turn");
          assert.include(reconnects[1], '"retries":2');
        }).pipe(
          Effect.provide(
            codexChildLayer.pipe(
              Layer.provideMerge(server),
              Layer.provideMerge(Logger.layer([logger])),
            ),
          ),
        ),
      );
    },
  );

  it.effect("opens the app server on the child's remote host", () => {
    const host = RemoteShell.make({
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
        yield* (yield* ChildBackend).launch(request(undefined, undefined, host));
        assert.deepStrictEqual(
          clients.map((client) => client.host),
          [host],
        );
      }).pipe(Effect.provide(codexChildLayer.pipe(Layer.provideMerge(server)))),
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
        const backend = yield* ChildBackend;
        const running = yield* backend.launch(request());
        const [events, result] = yield* Effect.all([
          Stream.runCollect(running.events),
          running.result,
        ]);
        assert.strictEqual(result.message, "The fix is done.");
        assert.strictEqual(events.filter((event) => event._tag === "TextOutput").length, 3);
      }).pipe(Effect.provide(codexChildLayer.pipe(Layer.provideMerge(server)))),
    );
  });

  it.effect("reports the thread's tokens with their split per billing rate", () => {
    const notifications: ReadonlyArray<CodexNotification> = [
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: {
              totalTokens: 130_400,
              inputTokens: 130_000,
              cachedInputTokens: 100_000,
              cacheWriteInputTokens: 20_000,
              outputTokens: 400,
              reasoningOutputTokens: 100,
            },
          },
        },
      },
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
        const backend = yield* ChildBackend;
        const running = yield* backend.launch(request());
        const [events] = yield* Effect.all([Stream.runCollect(running.events), running.result]);
        const report = events.find((event) => event._tag === "SessionTokensUpdated");
        assert(report !== undefined);
        assert.strictEqual(report.totalTokens, 30_400);
        assert(Option.isNone(report.costUsd));
        assert.deepStrictEqual(
          report.breakdown,
          Option.some(
            TokenBreakdown.make({
              input: 10000,
              cachedInput: 100000,
              cacheWrite: 20000,
              output: 400,
            }),
          ),
        );
      }).pipe(Effect.provide(codexChildLayer.pipe(Layer.provideMerge(server)))),
    );
  });

  it.effect("tolerates sparse rate windows, undecodable items, and unknown notifications", () => {
    const notifications: ReadonlyArray<CodexNotification> = [
      // Partial rate-limit update: only one window's load figure is present.
      {
        method: "account/rateLimits/updated",
        params: { rateLimits: { primary: { usedPercent: 91 } } },
      },
      // Undecodable item payload: logged and skipped, not fatal.
      { method: "item/completed", params: { nonsense: true } },
      // Server notifications with no normalized form.
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
        const backend = yield* ChildBackend;
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
      }).pipe(Effect.provide(codexChildLayer.pipe(Layer.provideMerge(server)))),
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
        const backend = yield* ChildBackend;
        const running = yield* backend.launch(request());
        const events = yield* Stream.runCollect(running.events);
        const finished = events.find((event) => event._tag === "ToolFinished");
        assert(finished !== undefined && finished._tag === "ToolFinished");
        assert.strictEqual(finished.isError, true);
      }).pipe(Effect.provide(codexChildLayer.pipe(Layer.provideMerge(server)))),
    );
  });

  it.effect("starts local API-key children and records their usage in the API keys pool", () => {
    const server = connectionLayer(
      {
        ...successfulResponses([{ id: "gpt-5.6-terra", model: "gpt-5.6-terra" }]),
        "account/read": { account: { type: "apiKey" }, requiresOpenaiAuth: true },
      },
      [
        { method: "account/updated", params: { authMode: "apikey" } },
        {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            tokenUsage: {
              total: {
                totalTokens: 15,
                inputTokens: 5,
                cachedInputTokens: 0,
                cacheWriteInputTokens: 0,
                outputTokens: 10,
                reasoningOutputTokens: 0,
              },
              last: {
                totalTokens: 15,
                inputTokens: 5,
                cachedInputTokens: 0,
                cacheWriteInputTokens: 0,
                outputTokens: 10,
                reasoningOutputTokens: 0,
              },
            },
          },
        },
        {
          method: "turn/completed",
          params: { turn: { id: "turn-1", status: "completed", error: null } },
        },
      ],
    );
    return Effect.scoped(
      Effect.gen(function* () {
        const running = yield* (yield* ChildBackend).launch(request());
        assert.deepStrictEqual(running.session.pool, Option.some("apiKeys"));
        assert.deepStrictEqual(running.session.endpoint, Option.some("openai"));
        const [events] = yield* Effect.all([Stream.runCollect(running.events), running.result]);
        assert(events.some((event) => event._tag === "SessionTokensUpdated"));
        for (const event of events) assert.strictEqual(sessionPool(event.session), "apiKeys");
      }).pipe(Effect.provide(codexChildLayer.pipe(Layer.provideMerge(server)))),
    );
  });

  for (const account of [null, { type: "amazonBedrock" }, { type: "unknown" }]) {
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
            const backend = yield* ChildBackend;
            const error = yield* Effect.flip(backend.launch(request()));
            const matchesError = Schema.is(PoolUnavailableError)(error);
            assert(matchesError);
            assert.strictEqual(toAttemptFailure(error)._tag, "AgentFailure");
            assert(
              !calls.some(({ method }) => method === "thread/start" || method === "turn/start"),
            );
          }).pipe(Effect.provide(codexChildLayer.pipe(Layer.provideMerge(server)))),
        );
      },
    );
  }

  it.effect(
    "attributes later rate windows to the new ChatGPT login after an account change",
    () => {
      const responses: Readonly<Record<string, Schema.Json>> = successfulResponses([
        { id: "gpt-5.6-terra", model: "gpt-5.6-terra" },
      ]);
      const rateUpdate = {
        method: "account/rateLimits/updated",
        params: { rateLimits: { primary: { usedPercent: 85 } } },
      };
      let accountReads = 0;
      const server = Layer.succeed(CodexAppServer)({
        stop: () => Effect.void,
        open: () =>
          Effect.succeed({
            close: Effect.void,
            notify: () => Effect.void,
            request: (_operation, method) =>
              Effect.sync(() =>
                method === "account/read"
                  ? {
                      account: {
                        type: "chatgpt",
                        email: ++accountReads === 1 ? "first@example.com" : "second@example.com",
                      },
                      requiresOpenaiAuth: true,
                    }
                  : (responses[method] ?? {}),
              ),
            notifications: Stream.fromIterable([
              rateUpdate,
              { method: "account/updated", params: { authMode: "chatgpt" } },
              rateUpdate,
              {
                method: "turn/completed",
                params: { turn: { id: "turn-1", status: "completed", error: null } },
              },
            ]),
          }),
      });
      return Effect.scoped(
        Effect.gen(function* () {
          const running = yield* (yield* ChildBackend).launch(request());
          const [events] = yield* Effect.all([Stream.runCollect(running.events), running.result]);
          assert.deepStrictEqual(
            events
              .filter((event) => event._tag === "PoolRateLimitsUpdated")
              .map(({ login }) => Option.getOrNull(login)),
            [PoolLogin.make("first@example.com"), PoolLogin.make("second@example.com")],
          );
        }).pipe(Effect.provide(codexChildLayer.pipe(Layer.provideMerge(server)))),
      );
    },
  );

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
        const backend = yield* ChildBackend;
        const running = yield* backend.launch(request());
        const error = yield* Effect.flip(running.result);
        const matchesError = Schema.is(PoolUnavailableError)(error);
        assert(matchesError);
        const events: Array<{ readonly _tag: string }> = [];
        const streamError = yield* running.events.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          ),
          Effect.flip,
        );
        const matchesStreamError = Schema.is(PoolUnavailableError)(streamError);
        assert(matchesStreamError);
        assert(!events.some((event) => event._tag === "PoolRateLimitsUpdated"));
      }).pipe(Effect.provide(codexChildLayer.pipe(Layer.provideMerge(server)))),
    );
  });

  for (const [credential, pool] of [
    ["subscription", "chatgptPlan"],
    ["api-key", "apiKeys"],
  ] as const)
    it.effect(
      `runs on the Gateway's OpenAI ${credential} without a login check, in the ${pool} pool`,
      () => {
        const calls: Array<{ readonly method: string; readonly params: Schema.Json }> = [];
        const { "account/read": _, ...withoutAccount } = successfulResponses([
          { id: "gpt-5.6-terra", model: "gpt-5.6-terra" },
        ]);
        const server = connectionLayer(
          withoutAccount,
          [
            { method: "account/updated", params: { authMode: "apikey" } },
            {
              method: "account/rateLimits/updated",
              params: { rateLimits: { primary: { usedPercent: 42 } } },
            },
            {
              method: "item/completed",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                item: { type: "agentMessage", id: "message-1", text: "Done through the gateway." },
              },
            },
            {
              method: "turn/completed",
              params: { turn: { id: "turn-1", status: "completed", error: null } },
            },
          ],
          calls,
        );
        const base = request();
        const codexHome = "/srv/usine/workers/eu-one/codex/run-1_execute_1";
        const throughGateway = ChildRequest.make({
          ...base,
          environment: { ...base.environment, CODEX_HOME: codexHome },
          session: ChildSession.make({
            ...base.session,
            gatewayCredential: Option.some(credential),
          }),
        });
        return Effect.scoped(
          Effect.gen(function* () {
            const backend = yield* ChildBackend;
            const running = yield* backend.launch(throughGateway);
            const [events, result] = yield* Effect.all([
              Stream.runCollect(running.events),
              running.result,
            ]);
            assert.strictEqual(result.message, "Done through the gateway.");
            assert(!calls.some(({ method }) => method === "account/read"));
            const limits = events.find((event) => event._tag === "PoolRateLimitsUpdated");
            assert(limits?._tag === "PoolRateLimitsUpdated");
            assert.strictEqual(limits.pool, pool);
            assert.deepStrictEqual(running.session.pool, Option.some(pool));
            assert.deepStrictEqual(
              running.session.endpoint,
              pool === "apiKeys" ? Option.some("openai") : Option.none(),
            );
            assert.deepStrictEqual(limits.session.pool, Option.some(pool));
            assert(Option.isNone(limits.login));
            const started = events[0];
            assert(started?._tag === "SessionStarted" && started.session._tag === "ChildSession");
            assert.deepStrictEqual(started.session.gatewayCredential, Option.some(credential));
            assert.deepStrictEqual(
              Option.flatMap(started.harnessSession, ({ home }) => home),
              Option.some(codexHome),
              "the session is saved in the Attempt's Codex home",
            );
          }).pipe(Effect.provide(codexChildLayer.pipe(Layer.provideMerge(server)))),
        );
      },
    );

  it.effect("rejects a model absent from the app-server catalog", () => {
    const server = connectionLayer(
      successfulResponses([{ id: "gpt-5.6-sol", model: "gpt-5.6-sol" }]),
    );
    return Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* ChildBackend;
        const error = yield* Effect.flip(backend.launch(request("gpt-never-existed")));
        const matchesError = Schema.is(UnknownModelError)(error);
        assert(matchesError);
        assert.strictEqual(error.harness, "codex");
      }).pipe(Effect.provide(codexChildLayer.pipe(Layer.provideMerge(server)))),
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
        const backend = yield* ChildBackend;
        const error = yield* Effect.flip(backend.launch(request("gpt-5.6-terra", "max")));
        const matchesError = Schema.is(UnsupportedEffortError)(error);
        assert(matchesError);
        assert.strictEqual(error.effort, "max");
        assert.strictEqual(error.model, "gpt-5.6-terra");
      }).pipe(Effect.provide(codexChildLayer.pipe(Layer.provideMerge(server)))),
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
        const backend = yield* ChildBackend;
        const running = yield* backend.launch(request());
        const error = yield* Effect.flip(running.result);
        const matchesError = Schema.is(AgentResultError)(error);
        assert(matchesError);
        assert.strictEqual(error.message, "the agent could not finish");
      }).pipe(Effect.provide(codexChildLayer.pipe(Layer.provideMerge(server)))),
    );
  });
});
