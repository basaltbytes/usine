import { assert } from "@effect/vitest";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { type AgentSessionEvent, AgentSessionId, ChildSession } from "@usine/core/agent/session";
import { Interrupt } from "@usine/core/attempt/channel";
import { WorkerName } from "@usine/core/worker";
import {
  type Cause,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Stream,
} from "effect";
import { LocalProcess } from "../../src/child-host/child-host.ts";
import { bridgeClient } from "../../src/harness/opencode/bridge/client.ts";
import {
  BridgeInput,
  type BridgeMcpConnect,
  type BridgeMcpMessage,
  type BridgeRequest,
} from "../../src/harness/opencode/bridge/lines.ts";
import { openCodeChildLayer } from "../../src/harness/opencode/opencode.ts";
import { OpenCodeServer, type OpenCodeTarget } from "../../src/harness/opencode/server.ts";
import {
  ChildBackend,
  ChildRequest,
  ChildSessionJournal,
  type RunningSession,
  type SessionOperationError,
  WorkingDirectory,
} from "../../src/runtime.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const decodeInput = Schema.decodeUnknownEffect(Schema.fromJsonString(BridgeInput));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

/** The OpenCode session ID that the scripted bridge creates. */
export const SESSION = "ses_scripted";

/** Returns an OpenCode event of the scripted session. */
export const event = (type: string, data: Record<string, Schema.Json> = {}): Schema.Json => ({
  event: { type, data: { sessionID: SESSION, ...data } },
});

/**
 * The bridge lines of one scripted OpenCode session. The bridge answers the requests that every
 * session sends: the model list, the new or saved session, the command environments, the inbox, the
 * jobs, and the active sessions, which are empty unless the test sets them.
 */
export interface ScriptedBridge {
  /** Where the runtime started the bridge. */
  readonly target: OpenCodeTarget;
  /** The next other request that the runtime sends, such as a prompt or an interrupt. */
  readonly request: Effect.Effect<BridgeRequest>;
  /** The next MCP line that the runtime sends: a connect line or a message. */
  readonly mcp: Effect.Effect<BridgeMcpConnect | BridgeMcpMessage>;
  /** Writes an output line. */
  readonly emit: (line: Schema.Json) => Effect.Effect<void>;
  /** Answers `request`, a request or an MCP connect line, with `status` and `body`. */
  readonly reply: (
    request: { readonly id: BridgeRequest["id"] },
    status: number,
    body: Schema.Json,
  ) => Effect.Effect<void>;
  /** Sets the running background work that job queries list from now on. */
  readonly setJobs: (jobs: ReadonlyArray<Schema.Json>) => Effect.Effect<void>;
  /** Sends the next query of `lookup` to `request` for the test to answer. */
  readonly holdNext: (lookup: Lookup) => Effect.Effect<void>;
  /** Sets the items that inbox queries list from now on. */
  readonly setInbox: (items: ReadonlyArray<Schema.Json>) => Effect.Effect<void>;
  /** Sets the sessions that active-session queries list from now on. */
  readonly setActive: (sessions: ReadonlyArray<string>) => Effect.Effect<void>;
  /** The OpenCode sessions whose command environment the runtime set, in order. */
  readonly environments: Effect.Effect<ReadonlyArray<string>>;
  /** The requests that the bridge answered by itself, in order. */
  readonly answered: Effect.Effect<ReadonlyArray<BridgeRequest>>;
  /** Fails the bridge's output with `error`, as a lost process does. */
  readonly lose: (error: SessionOperationError) => Effect.Effect<void>;
}

/** A query of OpenCode's state that the done check reads. */
type Lookup = "jobs" | "inbox" | "active";

const models = {
  data: [
    {
      id: "gpt-test",
      providerID: "openai",
      enabled: true,
      variants: [{ id: "none" }, { id: "low" }, { id: "medium" }],
    },
  ],
};

/** How the bridges of `scriptedServerWith` start. */
export interface ScriptedOptions {
  /** Whether the process owner kept each bridge running across the restart. */
  readonly retained?: boolean;
  /** The sessions that active-session queries list until the test sets them. */
  readonly active?: ReadonlyArray<string>;
  /** The items that inbox queries list until the test sets them. */
  readonly inbox?: ReadonlyArray<Schema.Json>;
}

/**
 * A fake `OpenCodeServer` whose bridges the test scripts. `bridge` completes when the runtime opens
 * the first one, after the ready line, and `bridges` takes each one in the order that the runtime
 * opens them, the first included.
 */
export const scriptedServerWith = Effect.fn("ScriptedServer.make")(function* (
  options: ScriptedOptions,
) {
  const bridge = yield* Deferred.make<ScriptedBridge>();
  const bridges = yield* Queue.unbounded<ScriptedBridge>();
  const layer = Layer.succeed(OpenCodeServer)({
    stop: () => Effect.void,
    open: (target) =>
      Effect.gen(function* () {
        const input = yield* Queue.make<Uint8Array, Cause.Done>();
        const output = yield* Queue.make<Uint8Array, SessionOperationError | Cause.Done>();
        const client = yield* bridgeClient({
          sessionId: target.sessionId,
          input,
          output: Stream.fromQueue(output),
          generation: Option.none(),
        });
        const emit = (line: Schema.Json) =>
          encodeJson(line).pipe(
            Effect.orDie,
            Effect.flatMap((text) => Queue.offer(output, encoder.encode(`${text}\n`))),
            Effect.asVoid,
          );
        const reply = (
          sent: { readonly id: BridgeRequest["id"] },
          status: number,
          body: Schema.Json,
        ) => emit({ id: sent.id, status, body });
        const jobs = yield* Ref.make<ReadonlyArray<Schema.Json>>([]);
        const held = yield* Ref.make<ReadonlySet<Lookup>>(new Set());
        /** Answers query `sent` of `lookup` with `body`, unless the test holds the next one. */
        const lookup = (sent: BridgeRequest, name: Lookup, body: Effect.Effect<Schema.Json>) =>
          Effect.gen(function* () {
            const holding = yield* Ref.modify(held, (names) => {
              const rest = new Set(names);
              rest.delete(name);
              return [names.has(name), rest];
            });
            if (holding) return yield* Queue.offer(others, sent).pipe(Effect.asVoid);
            const listed = yield* body;
            return yield* answer(sent, listed);
          });
        const inbox = yield* Ref.make<ReadonlyArray<Schema.Json>>(options.inbox ?? []);
        const active = yield* Ref.make<ReadonlyArray<string>>(options.active ?? []);
        const environments = yield* Ref.make<ReadonlyArray<string>>([]);
        const answered = yield* Ref.make<ReadonlyArray<BridgeRequest>>([]);
        const others = yield* Queue.unbounded<BridgeRequest>();
        const mcp = yield* Queue.unbounded<BridgeMcpConnect | BridgeMcpMessage>();
        const answer = (sent: BridgeRequest, body: Schema.Json) =>
          Ref.update(answered, (all) => [...all, sent]).pipe(
            Effect.andThen(reply(sent, 200, body)),
          );
        const session = { data: { id: SESSION, model: { id: "gpt-test", providerID: "openai" } } };
        yield* Queue.take(input).pipe(
          Effect.map((bytes) => decoder.decode(bytes).trimEnd()),
          Effect.flatMap(decodeInput),
          Effect.orDie,
          Effect.flatMap((sent) => {
            if ("environment" in sent)
              return Ref.update(environments, (all) => [...all, sent.environment]).pipe(
                Effect.andThen(reply(sent, 204, null)),
              );
            if ("mcp" in sent) return Queue.offer(mcp, sent).pipe(Effect.asVoid);
            if (sent.path.startsWith("/api/model")) return answer(sent, models);
            if (sent.method === "POST" && sent.path === "/api/session")
              return answer(sent, session);
            if (sent.method === "GET" && sent.path === `/api/session/${SESSION}`)
              return answer(sent, session);
            if (sent.path.endsWith("/inbox"))
              return lookup(
                sent,
                "inbox",
                Effect.map(Ref.get(inbox), (items) => ({ data: [...items] })),
              );
            if (sent.path === "/api/session/active")
              return lookup(
                sent,
                "active",
                Effect.map(Ref.get(active), (ids) => ({
                  data: Object.fromEntries(ids.map((id) => [id, {}])),
                })),
              );
            if (sent.path.startsWith("/api/experimental/job"))
              return lookup(
                sent,
                "jobs",
                Effect.map(Ref.get(jobs), (running) => ({ data: [...running] })),
              );
            return Queue.offer(others, sent).pipe(Effect.asVoid);
          }),
          Effect.forever,
          Effect.ignoreCause,
          Effect.forkScoped,
        );
        yield* emit({ ready: true });
        const scripted: ScriptedBridge = {
          target,
          request: Queue.take(others),
          mcp: Queue.take(mcp),
          emit,
          reply,
          setJobs: (running) => Ref.set(jobs, running),
          holdNext: (name) => Ref.update(held, (names) => new Set(names).add(name)),
          setInbox: (items) => Ref.set(inbox, items),
          setActive: (ids) => Ref.set(active, ids),
          environments: Ref.get(environments),
          answered: Ref.get(answered),
          lose: (error) => Queue.fail(output, error).pipe(Effect.asVoid),
        };
        yield* Deferred.succeed(bridge, scripted);
        yield* Queue.offer(bridges, scripted);
        yield* client.ready;
        return { ...client, retained: options.retained ?? false };
      }),
  });
  return { bridge: Deferred.await(bridge), bridges: Queue.take(bridges), layer };
});

/** `scriptedServerWith` with new bridges that are idle and empty. */
export const scriptedServer = scriptedServerWith({});

/** The child backend over `server`, with a journal that saves nothing. */
export const scriptedBackend = (server: Layer.Layer<OpenCodeServer>) =>
  openCodeChildLayer.pipe(Layer.provideMerge(ChildSessionJournal.layerNoop), Layer.provide(server));

/** A child request for OpenCode on the local worker with an API key. */
export const childRequest = ChildRequest.make({
  worker: WorkerName.make("scripted-worker"),
  machine: Option.none(),
  host: LocalProcess.make(),
  environment: { HOME: "/home/scripted", OPENAI_API_KEY: "sk-scripted" },
  cwd: WorkingDirectory.make("/work/checkout"),
  session: ChildSession.make({
    id: AgentSessionId.make("parent:scripted:child:1"),
    parentId: AgentSessionId.make("parent:scripted"),
    agent: AgentName.make("scripted"),
    brain: BrainSpec.make({
      harness: Harness.make("opencode"),
      model: ModelId.make("gpt-test"),
      effort: "low",
    }),
  }),
  prompt: "Do the scripted task.",
});

/** Asserts that `request` posts a prompt with `text`, and returns its OpenCode message ID if any. */
export const assertPrompt = (request: BridgeRequest, text: string): Option.Option<string> => {
  assert.strictEqual(request.method, "POST");
  assert.strictEqual(request.path, `/api/session/${SESSION}/prompt`);
  const body = Schema.decodeUnknownOption(
    Schema.Struct({ id: Schema.optionalKey(Schema.String), text: Schema.String }),
  )(request.body);
  assert(Option.isSome(body), "the prompt has a text body");
  assert.strictEqual(body.value.text, text);
  return Option.fromUndefinedOr(body.value.id);
};

/** Returns the cumulative tokens that OpenCode reports, with no cache use. */
export const tokens = (input: number, output: number) => ({
  input,
  output,
  reasoning: 0,
  cache: { read: 0, write: 0 },
});

/**
 * Launches the scripted child of `request` and runs its first execution up to a running tool
 * call after the text `before`. Returns the bridge, the running session, and its events as they
 * arrive.
 */
export const launched = (before: string, request: ChildRequest = childRequest) =>
  Effect.gen(function* () {
    const server = yield* scriptedServer;
    const fiber = yield* Effect.gen(function* () {
      const backend = yield* ChildBackend;
      return yield* backend.launch(request);
    }).pipe(Effect.provide(scriptedBackend(server.layer)), Effect.forkScoped);
    const bridge = yield* server.bridge;
    const prompt = yield* bridge.request;
    assertPrompt(prompt, request.prompt);
    yield* bridge.reply(prompt, 200, { data: { id: "msg_prompt" } });
    const running = yield* Fiber.join(fiber);
    const events = yield* Queue.unbounded<AgentSessionEvent>();
    const seen: Array<AgentSessionEvent> = [];
    const collector = yield* running.events.pipe(
      Stream.runForEach((value) =>
        Effect.sync(() => seen.push(value)).pipe(Effect.andThen(Queue.offer(events, value))),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );
    const until = (tag: AgentSessionEvent["_tag"]) =>
      Effect.gen(function* () {
        for (;;) {
          const next = yield* Queue.take(events);
          if (next._tag === tag) return next;
        }
      });
    for (const line of [
      event("session.inbox.enqueued", { inboxID: "msg_prompt" }),
      event("session.execution.started"),
      event("session.inbox.delivered", { inboxID: "msg_prompt" }),
      event("session.text.ended", { text: before }),
      event("session.tool.input.started", { id: "call_1", name: "shell" }),
      event("session.tool.called", { id: "call_1", input: { command: "sleep 60" } }),
    ])
      yield* bridge.emit(line);
    yield* until("ToolStarted");
    /** Waits for the session's events to end. */
    const ended = Fiber.join(collector);
    return { server, bridge, running, until, seen, ended };
  });

/** Interrupts the running execution through the conversation and answers the interrupt. */
export const interrupted = (bridge: ScriptedBridge, running: RunningSession) =>
  Effect.gen(function* () {
    const pause = yield* Effect.forkScoped(running.intervene(Interrupt.make(), () => Effect.void));
    const request = yield* bridge.request;
    assert.strictEqual(request.path, `/api/session/${SESSION}/interrupt`);
    yield* bridge.reply(request, 200, { interrupted: true });
    yield* Fiber.join(pause);
  });

/** The lines that end the execution of `launched` at its interrupt. */
export const oldExecutionEnds = [
  event("session.tool.failed", {
    id: "call_1",
    error: { type: "tool.execution", message: "killed" },
  }),
  event("session.execution.interrupted", { reason: "user" }),
];

/** The lines that end the first execution of `launched` with the answer `FIRST`. */
export const firstExecutionEnds = [
  event("session.tool.success", { id: "call_1", content: [{ type: "text", text: "done" }] }),
  event("session.text.ended", { text: "FIRST" }),
  event("session.step.ended"),
  event("session.usage.updated", { cost: 0.01, tokens: tokens(100, 10) }),
  event("session.execution.succeeded"),
];

/** Returns the `info` of a running shell `id` that session `session` started. */
export const shell = (id: string, session: string) => ({
  id,
  status: "running",
  command: "pnpm test",
  cwd: "/work/checkout",
  shell: "/usr/bin/bash",
  file: `/tmp/${id}.out`,
  metadata: { sessionID: session },
  time: { started: 0 },
});

/** The lines of an execution that delivers inbox item `id` and answers `text`. */
export const execution = (id: string, text: string) => [
  event("session.execution.started"),
  event("session.inbox.delivered", { inboxID: id }),
  event("session.text.ended", { text }),
  event("session.step.ended"),
  event("session.execution.succeeded"),
];
