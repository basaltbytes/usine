import { assert } from "@effect/vitest";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, ChildSession } from "@usine/core/agent/session";
import { WorkerName } from "@usine/core/worker";
import { type Cause, Deferred, Effect, Layer, Option, Queue, Ref, Schema, Stream } from "effect";
import { LocalProcess } from "../../src/child-host/child-host.ts";
import { bridgeClient } from "../../src/harness/opencode/bridge/client.ts";
import { BridgeRequest } from "../../src/harness/opencode/bridge/lines.ts";
import { openCodeChildLayer } from "../../src/harness/opencode/opencode.ts";
import { OpenCodeServer, type OpenCodeTarget } from "../../src/harness/opencode/server.ts";
import {
  ChildRequest,
  ChildSessionJournal,
  type SessionOperationError,
  WorkingDirectory,
} from "../../src/runtime.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(BridgeRequest));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

/** The OpenCode session ID that the scripted bridge creates. */
export const SESSION = "ses_scripted";

/** Returns an OpenCode event of the scripted session. */
export const event = (type: string, data: Record<string, Schema.Json> = {}): Schema.Json => ({
  event: { type, data: { sessionID: SESSION, ...data } },
});

/**
 * The bridge lines of one scripted OpenCode session. The bridge answers the requests that every
 * session sends: the model list, the new session, its inbox, which is empty, and its jobs.
 */
export interface ScriptedBridge {
  /** Where the runtime started the bridge. */
  readonly target: OpenCodeTarget;
  /** The next other request that the runtime sends, such as a prompt or an interrupt. */
  readonly request: Effect.Effect<BridgeRequest>;
  /** Writes an output line. */
  readonly emit: (line: Schema.Json) => Effect.Effect<void>;
  /** Answers `request` with `status` and `body`. */
  readonly reply: (
    request: BridgeRequest,
    status: number,
    body: Schema.Json,
  ) => Effect.Effect<void>;
  /** Sets the running background work that job queries list from now on. */
  readonly setJobs: (jobs: ReadonlyArray<Schema.Json>) => Effect.Effect<void>;
}

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

/**
 * A fake `OpenCodeServer` whose one bridge the test scripts. `bridge` completes when the runtime
 * opens it, after the ready line.
 */
export const scriptedServer = Effect.gen(function* () {
  const bridge = yield* Deferred.make<ScriptedBridge>();
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
        const reply = (sent: BridgeRequest, status: number, body: Schema.Json) =>
          emit({ id: sent.id, status, body });
        const jobs = yield* Ref.make<ReadonlyArray<Schema.Json>>([]);
        const others = yield* Queue.unbounded<BridgeRequest>();
        yield* Queue.take(input).pipe(
          Effect.map((bytes) => decoder.decode(bytes).trimEnd()),
          Effect.flatMap(decodeRequest),
          Effect.orDie,
          Effect.flatMap((sent) => {
            if (sent.path.startsWith("/api/model")) return reply(sent, 200, models);
            if (sent.method === "POST" && sent.path === "/api/session")
              return reply(sent, 200, {
                data: { id: SESSION, model: { id: "gpt-test", providerID: "openai" } },
              });
            if (sent.path.endsWith("/inbox")) return reply(sent, 200, { data: [] });
            if (sent.path.startsWith("/api/experimental/job"))
              return Effect.flatMap(Ref.get(jobs), (running) =>
                reply(sent, 200, { data: [...running] }),
              );
            return Queue.offer(others, sent).pipe(Effect.asVoid);
          }),
          Effect.forever,
          Effect.ignoreCause,
          Effect.forkScoped,
        );
        yield* emit({ ready: true });
        yield* Deferred.succeed(bridge, {
          target,
          request: Queue.take(others),
          emit,
          reply,
          setJobs: (running) => Ref.set(jobs, running),
        });
        yield* client.ready;
        return { ...client, retained: false };
      }),
  });
  return { bridge: Deferred.await(bridge), layer };
});

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
