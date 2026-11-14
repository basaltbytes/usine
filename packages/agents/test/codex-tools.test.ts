import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import {
  type AgentSessionEvent,
  AgentSessionId,
  HarnessSession,
  HarnessSessionId,
  RoleName,
  RoleSession,
} from "@usine/core/agent/session";
import { WorkerName } from "@usine/core/worker";
import {
  type Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { Tool, Toolkit } from "effect/ai";
import { LocalProcess, RemoteShell } from "../src/child-host/child-host.ts";
import { ChildProcessLost } from "../src/child-host/process.ts";
import { AdmissionContext, AdmittedBrain } from "../src/harness/admission.ts";
import {
  CodexAppServer,
  type CodexClient,
  type CodexConnection,
  type CodexNotification,
} from "../src/harness/codex/app-server.ts";
import { codexRuntime } from "../src/harness/codex/codex.ts";
import { continuationPolicy } from "../src/harness/continuation.ts";
import { SessionSpec, StartPrompt, StartResume } from "../src/harness/contract.ts";
import { RolePlacements, RoleSpec } from "../src/harness/role.ts";
import {
  HostLoginLock,
  RestartState,
  SessionOperationError,
  WorkingDirectory,
} from "../src/runtime.ts";
import { collectLogs } from "./logs.ts";

/** A name that Codex refuses: its characters fall outside `[A-Za-z0-9_-]`. */
const DOTTED = "notes.read";
const note = {
  parameters: Schema.Struct({ name: Schema.String }),
  success: Schema.String,
  failure: Schema.String,
};
const tools = Toolkit.make(
  Tool.make(DOTTED, { description: "Reads a usine note.", ...note }),
  Tool.make("mcp", { description: "Takes a name that Codex reserves.", ...note }),
);
const handlers = tools.toLayer({
  [DOTTED]: ({ name }) =>
    name === "greeting" ? Effect.succeed("Hello") : Effect.fail(`No note ${name}`),
  mcp: ({ name }) => Effect.succeed(name),
});

const role = RoleSpec.make({
  name: RoleName.make("tool-probe"),
  placement: RolePlacements.make({ placements: ["local"], reason: "The probe runs locally" }),
  credential: Option.none(),
  nativeTools: "all",
  hostTools: true,
  persistence: "saved",
  interventions: false,
  output: "text",
});
const brain = BrainSpec.make({
  harness: Harness.make("codex"),
  model: ModelId.make("gpt-5.6-terra"),
  effort: "low",
});
const spec = SessionSpec.make({
  session: RoleSession.make({
    id: AgentSessionId.make("codex-tools-1"),
    role: role.name,
    agent: AgentName.make("developer"),
    brain,
  }),
  admitted: AdmittedBrain.make({
    role,
    brain,
    context: AdmissionContext.make({ placement: "local", credential: "host-login" }),
    pool: Option.none(),
  }),
  host: LocalProcess.make(),
  worker: WorkerName.make("local"),
  machine: Option.none(),
  cwd: WorkingDirectory.make("/workspace/repo"),
  environment: { HOME: "/home/worker" },
});

const responses = new Map<string, Schema.Json>(
  Object.entries({
    initialize: {},
    "account/read": {
      account: { type: "chatgpt", email: "operator@example.com" },
      requiresOpenaiAuth: true,
    },
    "model/list": { data: [{ id: "gpt-5.6-terra", model: "gpt-5.6-terra" }] },
    "thread/start": { modelProvider: "openai", thread: { id: "thread-1" }, model: "gpt-5.6-terra" },
    "turn/start": { turn: { id: "turn-1" } },
  }),
);

const item = (method: string, fields: Record<string, Schema.Json>): CodexNotification => ({
  method,
  params: {
    threadId: "thread-1",
    turnId: "turn-1",
    item: { type: "dynamicToolCall", status: "completed", arguments: {}, ...fields },
  },
});

/** The requests that the session sent, and the client settings of each connection it opened. */
interface Observed {
  readonly calls: Array<{ readonly method: string; readonly params: Schema.Json }>;
  readonly clients: Array<CodexClient>;
}

const ThreadStart = Schema.Struct({
  dynamicTools: Schema.Array(
    Schema.Struct({
      type: Schema.Literal("namespace"),
      name: Schema.String,
      tools: Schema.Array(Schema.Struct({ name: Schema.String, inputSchema: Schema.Json })),
    }),
  ),
});

/** The `thread/start` tools that the session registered. */
const registered = (observed: Observed) =>
  Effect.suspend(() =>
    Schema.decodeUnknownEffect(ThreadStart)(
      observed.calls.find(({ method }) => method === "thread/start")?.params,
    ),
  ).pipe(
    Effect.orDie,
    Effect.map(({ dynamicTools }) => dynamicTools),
  );

/**
 * An app server that answers `responses` and reports a call of the first usine tool, then the
 * same name outside the namespace and an unknown name inside it.
 */
const appServer = (observed: Observed) =>
  Layer.succeed(CodexAppServer)({
    stop: () => Effect.void,
    open: (client) =>
      Effect.sync(() => {
        observed.clients.push(client);
        return {
          close: Effect.void,
          // The session reads notifications after `thread/start`.
          notifications: Stream.unwrap(
            Effect.map(registered(observed), (dynamicTools) => {
              const alias = dynamicTools[0]?.tools[0]?.name ?? "";
              return Stream.fromIterable([
                item("item/started", { id: "call-1", namespace: "usine", tool: alias }),
                item("item/completed", { id: "call-1", namespace: "usine", tool: alias }),
                item("item/completed", { id: "call-2", namespace: null, tool: alias }),
                item("item/completed", { id: "call-3", namespace: "usine", tool: "unknown" }),
                {
                  method: "turn/completed",
                  params: { turn: { id: "turn-1", status: "completed", error: null } },
                },
              ]);
            }),
          ),
          notify: (_operation, method, params) =>
            Effect.sync(() => observed.calls.push({ method, params })),
          request: (_operation, method, params) =>
            Effect.gen(function* () {
              observed.calls.push({ method, params });
              const response = responses.get(method);
              if (response === undefined)
                return yield* SessionOperationError.make({
                  operation: "stream",
                  sessionId: Option.none(),
                  message: `Unexpected ${method}`,
                  cause: new Error(method),
                });
              return response;
            }),
        };
      }),
  });

const readNoteTools = Toolkit.make(
  Tool.make("read_note", { description: "Reads a usine note.", ...note }),
);

/**
 * Handlers of `read_note` that report their start and interruption, and wait for `release`.
 *
 * With `holdStop`, an interrupted handler reports `stopping` and finishes stopping only after
 * `allowStop` completes.
 */
const readNoteGateWith = (options: { readonly holdStop: boolean }) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const stopping = yield* Deferred.make<void>();
    const allowStop = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    if (!options.holdStop) yield* Deferred.succeed(allowStop, undefined);
    const handlers = readNoteTools.toLayer({
      read_note: ({ name }) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(`Note ${name}`),
          Effect.onInterrupt(() =>
            Deferred.succeed(stopping, undefined).pipe(
              Effect.andThen(Deferred.await(allowStop)),
              Effect.andThen(Deferred.succeed(interrupted, undefined)),
            ),
          ),
        ),
    });
    return { started, release, stopping, allowStop, interrupted, handlers };
  });

const readNoteGate = readNoteGateWith({ holdStop: false });

const noteAnswer = { contentItems: [{ type: "inputText", text: "Note plan" }], success: true };

const readNoteItem = (method: string, status: string): CodexNotification =>
  item(method, {
    id: "call-1",
    namespace: "usine",
    tool: "read_note",
    status,
    success: status === "completed" ? true : status === "failed" ? false : null,
  });

const turnCompleted = (status: string): CodexNotification => ({
  method: "turn/completed",
  params: { turn: { id: "turn-1", status, error: null } },
});

/**
 * Reads Codex's call of `read_note` on the connection that the session opened `index`th, and
 * returns its answer.
 */
const readNoteCall = (observed: Observed, index: number) => {
  const answer = Option.flatMap(Option.fromUndefinedOr(observed.clients[index]?.serve), (serve) =>
    serve({
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: "usine",
        tool: "read_note",
        arguments: { name: "plan" },
      },
    }),
  );
  assert(Option.isSome(answer), `connection ${index} serves usine tool calls`);
  return answer.value;
};

/** Answers Codex's call of `read_note` on the connection that the session opened `index`th. */
const serveReadNote = (observed: Observed, index: number) =>
  Effect.suspend(() => readNoteCall(observed, index));

/**
 * An app server whose `n`th connection delivers the notifications that the test offers to
 * `inboxes[n]`, and that completes `reopened` when the session opens a second connection. A
 * resumed thread is in turn `turn-1`, with its `read_note` call pending.
 */
const scriptedAppServer = (
  observed: Observed,
  inboxes: ReadonlyArray<Queue.Queue<CodexNotification, SessionOperationError | Cause.Done>>,
  reopened?: Deferred.Deferred<void>,
) =>
  Layer.succeed(CodexAppServer)({
    stop: () => Effect.void,
    open: (client) =>
      Effect.sync(() => {
        const inbox = inboxes[observed.clients.length];
        observed.clients.push(client);
        assert(inbox !== undefined, "the session opens no more connections than the test expects");
        return {
          close: Queue.end(inbox),
          notifications: Stream.fromQueue(inbox),
          notify: (_operation, method, params) =>
            Effect.sync(() => observed.calls.push({ method, params })),
          request: (_operation, method, params) =>
            Effect.sync(() => {
              observed.calls.push({ method, params });
              if (method === "thread/resume")
                return {
                  modelProvider: "openai",
                  thread: {
                    id: "thread-1",
                    turns: [
                      {
                        id: "turn-1",
                        status: "inProgress",
                        items: [
                          {
                            type: "dynamicToolCall",
                            id: "call-1",
                            namespace: "usine",
                            tool: "read_note",
                            arguments: { name: "plan" },
                            status: "inProgress",
                          },
                        ],
                      },
                    ],
                  },
                };
              return responses.get(method) ?? {};
            }),
        } satisfies CodexConnection;
      }).pipe(
        Effect.tap(() =>
          observed.clients.length > 1 && reopened !== undefined
            ? Deferred.succeed(reopened, undefined)
            : Effect.void,
        ),
      ),
  });

const loginLock = Layer.effect(
  HostLoginLock,
  Effect.map(Semaphore.make(1), (mutex) =>
    HostLoginLock.of({ withLock: () => (effect) => mutex.withPermit(effect) }),
  ),
);

/** Opens a session that serves the toolkit and runs it to its result. */
const run = (observed: Observed) =>
  Effect.gen(function* () {
    const runtime = yield* codexRuntime;
    const policy = yield* continuationPolicy(spec, "Probe", RestartState.make({}));
    const native = yield* runtime.open(spec, StartPrompt.make({ text: "Probe" }), policy, tools);
    const events = yield* Effect.forkScoped(Stream.runCollect(native.running.events));
    yield* native.running.result;
    return yield* Fiber.join(events);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(handlers, appServer(observed), loginLock).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

describe("usine tool sets on Codex", () => {
  it.effect("registers the toolkit as one namespace on the experimental API", () =>
    Effect.gen(function* () {
      const observed: Observed = { calls: [], clients: [] };
      yield* run(observed);
      const initialize = observed.calls.find(({ method }) => method === "initialize");
      assert.deepStrictEqual(initialize?.params, {
        clientInfo: { name: "usine", title: "usine", version: "0.0.1" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      const dynamicTools = yield* registered(observed);
      assert.strictEqual(dynamicTools.length, 1);
      const [namespace] = dynamicTools;
      assert.strictEqual(namespace?.name, "usine");
      const names = namespace?.tools.map(({ name }) => name) ?? [];
      // Codex accepts neither name, so each gets an alias of accepted characters.
      assert.lengthOf(names, 2);
      assert.match(names[0] ?? "", /^notes_read_[a-z0-9]+$/);
      assert.match(names[1] ?? "", /^mcp_[a-z0-9]+$/);
      assert.deepStrictEqual<unknown>(
        namespace?.tools[0]?.inputSchema,
        Tool.getJsonSchema(tools.tools[DOTTED]),
      );
    }),
  );

  it.effect("answers item/tool/call with the handler's result, and a failure as an error", () =>
    Effect.gen(function* () {
      const observed: Observed = { calls: [], clients: [] };
      yield* run(observed);
      const [dotted, reserved] = (yield* registered(observed))[0]?.tools ?? [];
      assert(dotted !== undefined && reserved !== undefined);
      const serve = observed.clients[0]?.serve;
      assert(serve !== undefined, "the connection answers the session's tool calls");
      const call = (params: Schema.Json) => {
        const answer = serve({ method: "item/tool/call", params });
        assert(Option.isSome(answer));
        return answer.value;
      };
      const params = (namespace: string | null, tool: string, args: Schema.Json) => ({
        threadId: "thread-1",
        turnId: "turn-1",
        callId: `call-${tool}`,
        namespace,
        tool,
        arguments: args,
      });
      // The handlers run in the role's context, outside the session's scope.
      const answers = yield* Effect.all([
        call(params("usine", dotted.name, { name: "greeting" })),
        call(params("usine", dotted.name, { name: "missing" })),
        call(params("usine", reserved.name, { name: "kept" })),
        call(params("usine", dotted.name, { title: "no name" })),
        call(params(null, dotted.name, { name: "greeting" })),
        call(params("usine", "unknown", {})),
        call({ tool: "no call fields" }),
      ]).pipe(Effect.provide(handlers));
      const text = (value: string) => [{ type: "inputText", text: value }];
      assert.deepStrictEqual(answers.slice(0, 3), [
        { contentItems: text("Hello"), success: true },
        { contentItems: text("No note missing"), success: false },
        { contentItems: text("kept"), success: true },
      ]);
      for (const refused of answers.slice(3))
        assert.propertyVal(refused, "success", false, "the model reads a refused call as an error");
      assert.deepStrictEqual(answers[4], {
        contentItems: text(`No usine tool is named .${dotted.name}`),
        success: false,
      });
      assert.deepStrictEqual(answers[6], {
        contentItems: text("usine couldn't read the tool call"),
        success: false,
      });
      assert(Option.isNone(serve({ method: "item/commandExecution/requestApproval", params: {} })));
    }),
  );

  it.effect("names usine tool items by their toolkit names in events", () =>
    Effect.gen(function* () {
      const observed: Observed = { calls: [], clients: [] };
      const logs = collectLogs(["Info"]);
      const events = yield* run(observed).pipe(Effect.provide(logs.layer));
      const tools = events.flatMap((event) =>
        event._tag === "ToolStarted" || event._tag === "ToolFinished"
          ? [`${event._tag}:${event.tool}`]
          : [],
      );
      // Only a usine-namespace item whose alias the session registered maps back.
      assert.deepStrictEqual(tools, [
        `ToolStarted:${DOTTED}`,
        `ToolFinished:${DOTTED}`,
        "ToolFinished:dynamic_tool",
        "ToolFinished:dynamic_tool",
      ]);
      assert.include(
        logs.records.map(({ message }) => (Array.isArray(message) ? message[0] : message)),
        "Aliased a usine tool name",
      );
    }),
  );

  for (const ending of ["completes the call's item", "ends the turn"] as const)
    it.effect(`interrupts a pending call's handler when Codex ${ending} first`, () =>
      Effect.gen(function* () {
        // The handler waits in its interruption until the test sees whether the item finished.
        const gate = yield* readNoteGateWith({ holdStop: ending === "completes the call's item" });
        const observed: Observed = { calls: [], clients: [] };
        const inbox = yield* Queue.make<CodexNotification, SessionOperationError | Cause.Done>();
        const logs = collectLogs(["Info"]);
        yield* Effect.gen(function* () {
          const runtime = yield* codexRuntime;
          const policy = yield* continuationPolicy(spec, "Probe", RestartState.make({}));
          const native = yield* runtime.open(
            spec,
            StartPrompt.make({ text: "Probe" }),
            policy,
            readNoteTools,
          );
          const events: Array<AgentSessionEvent> = [];
          const finished = yield* Deferred.make<void>();
          // The events end with the interrupted turn's failure.
          const transcript = yield* Effect.forkScoped(
            native.running.events.pipe(
              Stream.runForEach((event) =>
                Effect.sync(() => events.push(event)).pipe(
                  Effect.andThen(
                    event._tag === "ToolFinished"
                      ? Deferred.succeed(finished, undefined)
                      : Effect.void,
                  ),
                ),
              ),
              Effect.exit,
            ),
          );
          yield* Queue.offer(inbox, readNoteItem("item/started", "inProgress"));
          const answer = yield* Effect.forkScoped(serveReadNote(observed, 0));
          yield* Deferred.await(gate.started);
          yield* native.running.interrupt;
          // Codex fails the item of a call that it cancelled, and drops a late answer.
          if (ending === "completes the call's item") {
            yield* Queue.offer(inbox, readNoteItem("item/completed", "failed"));
            yield* Deferred.await(gate.stopping);
            // Lets the events consumer see a ToolFinished that the session emitted too early.
            yield* Effect.repeat(Effect.yieldNow, { times: 20 });
            const early = yield* Deferred.isDone(finished);
            yield* Deferred.succeed(gate.allowStop, undefined);
            assert.isFalse(early, "the item isn't reported finished while the handler stops");
            yield* Deferred.await(finished);
            const stopped = yield* Deferred.isDone(gate.interrupted);
            assert.isTrue(stopped, "the handler stops before the item is reported finished");
          }
          yield* Queue.offer(inbox, turnCompleted("interrupted"));
          const result = yield* Effect.exit(native.running.result);
          assert(Exit.isFailure(result));
          const interrupted = yield* Deferred.isDone(gate.interrupted);
          assert.isTrue(interrupted, "the handler is interrupted");
          const answered = yield* Fiber.await(answer);
          assert(Exit.hasInterrupts(answered), "nothing answers the call");
          yield* Fiber.join(transcript);
          if (ending === "completes the call's item")
            assert.deepStrictEqual(
              events.flatMap((event) =>
                event._tag === "ToolFinished" ? [[event.tool, event.isError]] : [],
              ),
              [["read_note", true]],
            );
        }).pipe(
          Effect.scoped,
          Effect.provide(
            Layer.mergeAll(
              gate.handlers,
              scriptedAppServer(observed, [inbox]),
              loginLock,
              logs.layer,
            ).pipe(Layer.provideMerge(NodeServices.layer)),
          ),
        );
        assert.includeMembers(
          logs.records.map(({ message }) => (Array.isArray(message) ? message[0] : message)),
          [
            "Cancelling a usine tool call that Codex no longer waits for",
            "Usine tool call was cancelled",
          ],
        );
      }),
    );

  it.effect("doesn't run a call that Codex completes before its answer starts", () =>
    Effect.gen(function* () {
      const gate = yield* readNoteGate;
      const observed: Observed = { calls: [], clients: [] };
      const inbox = yield* Queue.make<CodexNotification, SessionOperationError | Cause.Done>();
      yield* Effect.gen(function* () {
        const runtime = yield* codexRuntime;
        const policy = yield* continuationPolicy(spec, "Probe", RestartState.make({}));
        const native = yield* runtime.open(
          spec,
          StartPrompt.make({ text: "Probe" }),
          policy,
          readNoteTools,
        );
        const finished = yield* Deferred.make<void>();
        yield* Effect.forkScoped(
          native.running.events.pipe(
            Stream.runForEach((event) =>
              event._tag === "ToolFinished" ? Deferred.succeed(finished, undefined) : Effect.void,
            ),
            Effect.exit,
          ),
        );
        // The connection registers the call when it reads it, before the answer's fiber runs.
        const answer = readNoteCall(observed, 0);
        yield* Queue.offer(inbox, readNoteItem("item/started", "inProgress"));
        yield* Queue.offer(inbox, readNoteItem("item/completed", "failed"));
        yield* Deferred.await(finished);
        const answered = yield* Effect.exit(answer);
        assert(Exit.hasInterrupts(answered));
        const started = yield* Deferred.isDone(gate.started);
        assert.isFalse(started, "the handler never runs");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(gate.handlers, scriptedAppServer(observed, [inbox]), loginLock).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      );
    }),
  );

  it.effect("serves the calls that a resumed thread sends on the reattached connection", () =>
    Effect.gen(function* () {
      const gate = yield* readNoteGate;
      yield* Deferred.succeed(gate.release, undefined);
      const observed: Observed = { calls: [], clients: [] };
      const inbox = yield* Queue.make<CodexNotification, SessionOperationError | Cause.Done>();
      const saved = HarnessSession.make({
        id: HarnessSessionId.make("thread-1"),
        cwd: spec.cwd,
        home: Option.none(),
        modelProvider: Option.none(),
      });
      yield* Effect.gen(function* () {
        const runtime = yield* codexRuntime;
        const policy = yield* continuationPolicy(spec, "Probe", RestartState.make({}));
        const native = yield* runtime.open(
          spec,
          StartResume.make({ reference: saved }),
          policy,
          readNoteTools,
        );
        assert.isTrue(native.active, "the resumed thread is in its turn");
        assert.strictEqual(observed.clients[0]?.transport, "resume");
        // Codex sends the pending call again on the reattached connection.
        const answer = yield* serveReadNote(observed, 0);
        assert.deepStrictEqual(answer, noteAnswer);
        yield* Queue.offer(inbox, readNoteItem("item/completed", "completed"));
        yield* Queue.offer(inbox, turnCompleted("completed"));
        yield* native.running.result;
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(gate.handlers, scriptedAppServer(observed, [inbox]), loginLock).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      );
    }),
  );

  it.effect("serves calls on the connection that replaces a lost transport", () =>
    Effect.gen(function* () {
      const gate = yield* readNoteGate;
      const observed: Observed = { calls: [], clients: [] };
      const lost = yield* Queue.make<CodexNotification, SessionOperationError | Cause.Done>();
      const replaced = yield* Queue.make<CodexNotification, SessionOperationError | Cause.Done>();
      const reopened = yield* Deferred.make<void>();
      const remote = SessionSpec.make({
        ...spec,
        host: RemoteShell.make({
          ssh: { command: "ssh", args: [] },
          sshEnvironment: {},
          destination: "worker",
        }),
      });
      yield* Effect.gen(function* () {
        const runtime = yield* codexRuntime;
        const policy = yield* continuationPolicy(remote, "Probe", RestartState.make({}));
        const native = yield* runtime.open(
          remote,
          StartPrompt.make({ text: "Probe" }),
          policy,
          readNoteTools,
        );
        yield* Queue.offer(lost, readNoteItem("item/started", "inProgress"));
        const orphaned = yield* Effect.forkScoped(serveReadNote(observed, 0));
        yield* Deferred.await(gate.started);
        yield* Queue.fail(
          lost,
          SessionOperationError.make({
            operation: "stream",
            sessionId: Option.some(spec.session.id),
            message: "App-server exited",
            cause: ChildProcessLost.make({ exitCode: 1, stderrTail: "" }),
          }),
        );
        yield* Deferred.await(reopened);
        // The lost process no longer waits for its call.
        const interrupted = yield* Deferred.isDone(gate.interrupted);
        assert.isTrue(interrupted);
        const answered = yield* Fiber.await(orphaned);
        assert(Exit.hasInterrupts(answered));
        yield* Deferred.succeed(gate.release, undefined);
        // The resumed thread sends the call again on the replacement connection.
        const answer = yield* serveReadNote(observed, 1);
        assert.strictEqual(observed.clients[1]?.transport, "replace");
        assert.deepStrictEqual(answer, noteAnswer);
        yield* Queue.offer(replaced, readNoteItem("item/completed", "completed"));
        yield* Queue.offer(replaced, turnCompleted("completed"));
        yield* native.running.result;
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            gate.handlers,
            scriptedAppServer(observed, [lost, replaced], reopened),
            loginLock,
          ).pipe(Layer.provideMerge(NodeServices.layer)),
        ),
      );
    }),
  );
});
