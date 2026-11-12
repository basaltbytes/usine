import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, RoleName, RoleSession } from "@usine/core/agent/session";
import { WorkerName } from "@usine/core/worker";
import { Effect, Fiber, Layer, Option, Schema, Semaphore, Stream } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { LocalProcess } from "../src/child-host/child-host.ts";
import { AdmissionContext, AdmittedBrain } from "../src/harness/admission.ts";
import {
  CodexAppServer,
  type CodexClient,
  type CodexNotification,
} from "../src/harness/codex/app-server.ts";
import { codexRuntime } from "../src/harness/codex/codex.ts";
import { continuationPolicy } from "../src/harness/continuation.ts";
import { SessionSpec, StartPrompt } from "../src/harness/contract.ts";
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
  nativeTools: true,
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
});
