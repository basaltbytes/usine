// The SDK and native HTTP test boundary use Promise callbacks.
// @effect-diagnostics asyncFunction:off
// The fixture inspects the native request headers sent by the vendor SDK.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createServer } from "node:http";
import { NodeHttpClient, NodeHttpServer } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { PiGateway, piGatewayPool } from "@usine/agents/pi/gateway";
import { HttpClient } from "effect/http";
import { jsonKey } from "@usine/core/json-key";
import { RunSpec } from "@usine/core/attempt/channel";
import { ModelId } from "@usine/core/agent/brain";
import { Effect, Fiber, Latch, Layer, Option, Redacted, Schema } from "effect";
import { parentModels, parentProviderSession } from "../src/attempt/models.ts";
import { AttemptId } from "@usine/core/attempt";
import { AttemptRequest, AttemptRuntime } from "../src/attempt-runtime.ts";
import { layer as attemptRuntimeLayer } from "../src/attempt/runtime.ts";
import { durableError, layer as durableHarnessLayer } from "../src/harness.ts";
import { stubChildBackendLayer } from "../src/testing.ts";
import { attemptRequest, recordingSink, temporaryDatabase } from "./support.ts";

const completed = () => {
  const item = {
    type: "message",
    id: "msg-1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Done through gateway.", annotations: [] }],
  };
  return [
    { type: "response.created", response: { id: "resp-1", status: "in_progress", output: [] } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, content: [], status: "in_progress" },
    },
    {
      type: "response.content_part.added",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: "Done through gateway.",
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp-1",
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    },
  ]
    .map((event) => `event: ${event.type}\ndata: ${jsonKey(event)}\n\n`)
    .join("");
};

const anthropicCompleted = () =>
  [
    {
      type: "message_start",
      message: {
        id: "msg-a",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Compacted through gateway." },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 },
    },
    { type: "message_stop" },
  ]
    .map((event) => `event: ${event.type}\ndata: ${jsonKey(event)}\n\n`)
    .join("");

const gatewayServer = (holdFirst = false) =>
  Effect.gen(function* () {
    const first = yield* Latch.make();
    const requests: Array<{
      path: string | undefined;
      host: string | undefined;
      token: string | undefined;
      body: unknown;
    }> = [];
    const server = yield* NodeHttpServer.make(
      () =>
        createServer((request, response) => {
          const chunks: Array<Buffer> = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            const decoded = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown))(
              Buffer.concat(chunks).toString(),
            );
            assert(Option.isSome(decoded));
            requests.push({
              path: request.url,
              host: request.headers.host,
              token:
                request.headers.authorization ??
                (Schema.is(Schema.String)(request.headers["x-api-key"])
                  ? `Bearer ${request.headers["x-api-key"]}`
                  : undefined),
              body: decoded.value,
            });
            response.writeHead(200, { "content-type": "text/event-stream" });
            first.openUnsafe();
            if (holdFirst && requests.length === 1) response.flushHeaders();
            else
              response.end(
                request.url?.includes("anthropic-messages") === true
                  ? anthropicCompleted()
                  : completed(),
              );
          });
        }),
      { host: "127.0.0.1", port: 0 },
    );
    assert(server.address._tag !== "UnixPathAddress");
    return { requests, first: first.await, baseUrl: `http://127.0.0.1:${server.address.port}` };
  });

it.live.each(["subscription", "api-key"] as const)(
  "runs a coordinator without a host login and accounts for the gateway's %s credential",
  (kind) =>
    Effect.gen(function* () {
      const server = yield* gatewayServer();
      const database = yield* temporaryDatabase;
      const models = createModels({
        authContext: { env: async () => undefined, fileExists: async () => false },
      });
      const provider = openaiCodexProvider();
      models.setProvider(provider);
      const selected = provider.getModels()[0];
      assert(selected !== undefined);
      const localAuth = yield* Effect.promise(() => models.checkAuth(provider.id));
      assert.isUndefined(localAuth);
      const model = ModelId.make(`${provider.id}/${selected.id}`);
      const gateway = PiGateway.make({
        httpClient: yield* HttpClient.HttpClient,
        baseUrl: Effect.succeed(server.baseUrl),
        host: "llm.gw.test",
        callerToken: Redacted.make("attempt-caller-token"),
        credentials: { "anthropic-messages": Option.none(), "openai-responses": Option.some(kind) },
      });
      const original = attemptRequest(`gateway-${kind}`);
      const withGateway = AttemptRequest.make({
        ...original,
        spec: RunSpec.make({
          ...original.spec,
          parentModel: Option.some(model),
          parentEffort: "low",
        }),
        modelGateway: Option.some(gateway),
      });
      const services = attemptRuntimeLayer.pipe(
        Layer.provideMerge(
          durableHarnessLayer({
            models,
            defaultModel: Option.none(),
            openStorage: Effect.tryPromise({
              try: () => openNodeSqliteStorage(database),
              catch: (cause) => durableError("open test storage", cause),
            }),
          }),
        ),
        Layer.provide(stubChildBackendLayer),
      );
      const recording = recordingSink();
      yield* Effect.gen(function* () {
        const runtime = yield* AttemptRuntime;
        const report = yield* runtime.execute(withGateway, recording.sink);
        assert.strictEqual(report.message, "Done through gateway.");
      }).pipe(Effect.provide(services), Effect.scoped);
      const sent = server.requests[0];
      assert(sent !== undefined);
      assert.strictEqual(sent.path, "/openai-responses/v1/responses");
      assert.strictEqual(sent.host, "llm.gw.test");
      assert.strictEqual(sent.token, "Bearer attempt-caller-token");
      const payload = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          instructions: Schema.String,
          store: Schema.Boolean,
          input: Schema.Array(Schema.Unknown),
        }),
      )(sent.body);
      assert.include(payload.instructions, "You coordinate one usine Attempt");
      assert.isFalse(payload.store);
      const raw = yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown))(
        sent.body,
      );
      assert.isFalse(Object.hasOwn(raw, "max_output_tokens"));
      const pools = recording
        .outbound()
        .flatMap(({ payload }) =>
          payload._tag === "SessionEvent" && payload.event.session._tag === "ParentSession"
            ? [payload.event.session.pool]
            : [],
        );
      assert.isAbove(pools.length, 0);
      for (const pool of pools)
        assert.deepStrictEqual(
          pool,
          Option.some(kind === "subscription" ? "chatgptPlan" : "apiKeys"),
        );
    }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp), Effect.scoped),
);

it.effect(
  "reports the missing coordinator provider and refuses a Claude subscription through Pi",
  () =>
    Effect.gen(function* () {
      const missing = yield* piGatewayPool(ModelId.make("openai-codex/gpt-5"), {
        "anthropic-messages": Option.none(),
        "openai-responses": Option.none(),
      }).pipe(Effect.flip);
      assert.include(missing.message, 'provider "openai-codex"');
      const refused = yield* piGatewayPool(ModelId.make("anthropic/claude-sonnet-4-6"), {
        "anthropic-messages": Option.some("subscription"),
        "openai-responses": Option.none(),
      }).pipe(Effect.flip);
      assert.include(refused.message, "Claude subscriptions require Claude Code");
    }),
);

it.live("waits for a fresh gateway attachment after restart and refreshes the pool", () =>
  Effect.gen(function* () {
    const server = yield* gatewayServer(true);
    const database = yield* temporaryDatabase;
    const models = createModels({
      authContext: { env: async () => undefined, fileExists: async () => false },
    });
    const provider = openaiCodexProvider();
    models.setProvider(provider);
    const selected = provider.getModels()[0];
    assert(selected !== undefined);
    const httpClient = yield* HttpClient.HttpClient;
    const original = attemptRequest("gateway-restart");
    const request = (token: string, kind: "subscription" | "api-key") =>
      AttemptRequest.make({
        ...original,
        spec: RunSpec.make({
          ...original.spec,
          parentModel: Option.some(ModelId.make(`${provider.id}/${selected.id}`)),
          parentEffort: "low",
        }),
        modelGateway: Option.some(
          PiGateway.make({
            httpClient,
            baseUrl: Effect.succeed(server.baseUrl),
            host: "llm.gw.test",
            callerToken: Redacted.make(token),
            credentials: {
              "anthropic-messages": Option.none(),
              "openai-responses": Option.some(kind),
            },
          }),
        ),
      });
    const services = () =>
      attemptRuntimeLayer.pipe(
        Layer.provideMerge(
          durableHarnessLayer({
            models,
            defaultModel: Option.none(),
            openStorage: Effect.tryPromise({
              try: () => openNodeSqliteStorage(database),
              catch: (cause) => durableError("open restart storage", cause),
            }),
          }),
        ),
        Layer.provide(stubChildBackendLayer),
      );
    const recording = recordingSink();
    yield* Effect.gen(function* () {
      const runtime = yield* AttemptRuntime;
      const execution = yield* Effect.forkChild(
        runtime.execute(request("old-caller", "subscription"), recording.sink),
      );
      yield* server.first;
      yield* Fiber.interrupt(execution);
    }).pipe(Effect.provide(services()), Effect.scoped);
    yield* Effect.gen(function* () {
      const runtime = yield* AttemptRuntime;
      // Give the resumed generation a chance to run before supplying a new attachment.
      yield* Effect.sleep("100 millis");
      assert.lengthOf(server.requests, 1);
      const report = yield* runtime.execute(request("fresh-caller", "api-key"), recording.sink);
      assert.strictEqual(report.message, "Done through gateway.");
    }).pipe(Effect.provide(services()), Effect.scoped);
    assert.lengthOf(server.requests, 2);
    assert.strictEqual(server.requests[1]?.token, "Bearer fresh-caller");
    const pools = recording
      .outbound()
      .flatMap(({ payload }) =>
        payload._tag === "SessionEvent" &&
        payload.event._tag === "SessionFinished" &&
        payload.event.session._tag === "ParentSession"
          ? [payload.event.session.pool]
          : [],
      );
    assert.deepStrictEqual(pools, [Option.some("apiKeys")]);
  }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp), Effect.scoped),
);

it.live(
  "routes Anthropic completeSimple requests used by compaction through their own caller tokens",
  () =>
    Effect.gen(function* () {
      const server = yield* gatewayServer();
      const models = createModels({
        authContext: { env: async () => undefined, fileExists: async () => false },
      });
      const provider = anthropicProvider();
      models.setProvider(provider);
      const model = provider.getModels()[0];
      assert(model !== undefined);
      const auth = yield* Effect.promise(() => models.checkAuth(provider.id));
      assert.isUndefined(auth);
      const httpClient = yield* HttpClient.HttpClient;
      const services = yield* Effect.context<never>();
      const failures: Array<unknown> = [];
      const routed = parentModels(
        models,
        async (attemptId) => ({
          ...PiGateway.make({
            httpClient,
            baseUrl: Effect.succeed(server.baseUrl),
            host: "llm.gw.test",
            callerToken: Redacted.make(attemptId),
            credentials: {
              "anthropic-messages": Option.some("api-key"),
              "openai-responses": Option.none(),
            },
          }),
          baseUrl: server.baseUrl,
        }),
        async (_, cause) => {
          failures.push(cause);
        },
        (effect, signal) => Effect.runPromiseWith(services)(effect, { signal }),
      );
      const results = yield* Effect.forEach(
        ["compaction-one", "compaction-two"],
        (id) =>
          Effect.tryPromise({
            try: () =>
              routed.completeSimple(
                model,
                {
                  messages: [
                    { role: "user", content: "Summarize the conversation.", timestamp: 0 },
                  ],
                },
                { sessionId: parentProviderSession(AttemptId.make(id)) },
              ),
            catch: (cause) => durableError("complete through gateway", cause),
          }),
        { concurrency: "unbounded" },
      );
      assert.deepStrictEqual(failures, []);
      assert.isTrue(results.every((message) => message.stopReason === "stop"));
      assert.deepStrictEqual(server.requests.map(({ token }) => token).sort(), [
        "Bearer compaction-one",
        "Bearer compaction-two",
      ]);
      for (const request of server.requests) {
        assert.strictEqual(request.path, "/anthropic-messages/v1/messages");
        assert.strictEqual(request.host, "llm.gw.test");
      }
    }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp), Effect.scoped),
);
