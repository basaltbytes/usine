// SDK tests exercise Promise callbacks and streaming responses.
// @effect-diagnostics asyncFunction:off
import { assert, it } from "@effect/vitest";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { jsonKey } from "@usine/core/json-key";
import { ModelId } from "@usine/core/agent/brain";
import { RunSpec } from "@usine/core/attempt/channel";
import type { GatewayCredentialKind } from "@usine/core/worker";
import { Effect, Layer, Option, Schema } from "effect";
import { gatewayModelAccess } from "../src/gateway.ts";
import { DurableHarness, durableError, layer as harnessLayer } from "../src/harness.ts";
import { AttemptRequest, AttemptRuntime } from "../src/attempt-runtime.ts";
import { layer as runtimeLayer } from "../src/attempt/runtime.ts";
import { resolveParent } from "../src/attempt/parent.ts";
import { stubChildBackendLayer } from "../src/testing.ts";
import { attemptRequest, recordingSink, temporaryDatabase } from "./support.ts";

const response = () => {
  const item = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "Finished through the gateway.", annotations: [] }],
  };
  const events = [
    { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    {
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: "Finished through the gateway.",
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        output: [item],
        usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
      },
    },
  ];
  return new Response(events.map((event) => `data: ${jsonKey(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
};

it.live.each(["api-key", "subscription"] as const)(
  "runs a coordinator with a gateway %s credential and records its pool",
  (credential) =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const sent: Array<{ protocol: string; body: string }> = [];
      let current: GatewayCredentialKind | undefined = credential;
      const access = gatewayModelAccess({
        credential: async () => current,
        request: async (protocol, body) => {
          sent.push({ protocol, body });
          return response();
        },
      });
      const model = ModelId.make("openai-codex/gpt-5.6-sol");
      const original = attemptRequest(`gateway-${credential}`);
      const request = AttemptRequest.make({
        ...original,
        spec: RunSpec.make({ ...original.spec, parentModel: Option.some(model) }),
      });
      const pool = credential === "subscription" ? "chatgptPlan" : "apiKeys";
      const harness = harnessLayer({
        models: access.models,
        parentAuthentication: access.authentication,
        defaultModel: Option.none(),
        openStorage: Effect.tryPromise({
          try: () => openNodeSqliteStorage(database),
          catch: (cause) => durableError("open test storage", cause),
        }),
      });
      const recording = recordingSink();
      yield* Effect.gen(function* () {
        const runtime = yield* AttemptRuntime;
        const report = yield* runtime.execute(request, recording.sink);
        assert.strictEqual(report.message, "Finished through the gateway.");
        const selected = yield* resolveParent(
          access.models,
          Option.none(),
          request.spec,
          Option.none(),
          access.authentication,
        );
        assert.strictEqual(selected.pool, pool);
        const durable = yield* DurableHarness;
        assert.strictEqual(durable.parentAuthentication, access.authentication);
        current = undefined;
        const missing = yield* resolveParent(
          access.models,
          Option.none(),
          request.spec,
          Option.none(),
          access.authentication,
        ).pipe(Effect.flip);
        assert.include(
          missing.message,
          'Gateway credential unavailable for provider "openai-codex"',
        );
      }).pipe(
        Effect.provide(
          runtimeLayer.pipe(Layer.provideMerge(harness), Layer.provide(stubChildBackendLayer)),
        ),
      );
      assert.lengthOf(sent, 1);
      assert.strictEqual(sent[0]?.protocol, "openai-responses");
      const body = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            store: Schema.Boolean,
            instructions: Schema.String,
            max_output_tokens: Schema.optionalKey(Schema.Finite),
          }),
        ),
      )(sent[0]?.body);
      assert.strictEqual(body.store, false);
      assert.isString(body.instructions);
      assert.isUndefined(body.max_output_tokens);
      const usage = recording
        .outbound()
        .flatMap(({ payload }) =>
          payload._tag === "SessionEvent" && payload.event._tag === "SessionTokensUpdated"
            ? [payload.event]
            : [],
        );
      assert.lengthOf(usage, 1);
      for (const event of usage) {
        assert.deepStrictEqual(event.session.pool, Option.some(pool));
        assert.strictEqual(event.totalTokens, 20);
      }
    }).pipe(Effect.scoped),
);

it.effect(
  "refuses subscription credentials for API-key providers and never reads ambient logins",
  () =>
    Effect.gen(function* () {
      const access = gatewayModelAccess({
        credential: async () => "subscription",
        request: async () => response(),
      });
      const signal = yield* Effect.abortSignal;
      for (const provider of ["anthropic", "openai", "google"]) {
        const authentication = yield* Effect.promise(() => access.authentication(provider, signal));
        assert.isUndefined(authentication);
      }
      assert.isUndefined(access.models.getProvider("google"));
    }),
);

it.effect("startup reports a missing gateway credential by coordinator provider", () =>
  Effect.gen(function* () {
    const access = gatewayModelAccess({
      credential: async () => undefined,
      request: async () => response(),
    });
    const failure = yield* resolveParent(
      access.models,
      Option.none(),
      {
        parentModel: Option.some(ModelId.make("openai-codex/gpt-5.6-sol")),
        parentEffort: "high",
      },
      Option.none(),
      access.authentication,
    ).pipe(Effect.flip);
    assert.include(failure.message, 'Gateway credential unavailable for provider "openai-codex"');
  }),
);
