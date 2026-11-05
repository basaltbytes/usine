// SDK tests exercise Promise callbacks and streaming responses.
// @effect-diagnostics asyncFunction:off
import { assert, it } from "@effect/vitest";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { jsonKey } from "@usine/core/json-key";
import { ModelId } from "@usine/core/agent/brain";
import { RunSpec } from "@usine/core/attempt/channel";
import type { GatewayCredentialKind } from "@usine/core/worker";
import { Effect, Fiber, Layer, Option, Schema } from "effect";
import { gatewayModelAccess } from "../src/gateway.ts";
import { DurableHarness, durableError, layer as harnessLayer } from "../src/harness.ts";
import { AttemptRequest, AttemptRuntime } from "../src/attempt-runtime.ts";
import { layer as runtimeLayer } from "../src/attempt/runtime.ts";
import { resolveParent } from "../src/attempt/parent.ts";
import { StubChildren, stubChildBackendLayer } from "../src/testing.ts";
import { attemptRequest, recordingSink, temporaryDatabase } from "./support.ts";

const response = (terminal: "response.completed" | "response.done" = "response.completed") => {
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
      type: terminal,
      response: {
        id: "resp_1",
        status: "completed",
        output: [item],
        usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
      },
    },
  ];
  return eventStream(events, "data: [DONE]\r\n\r\n");
};

/** Streams `events` as server-sent events in 17-byte chunks, followed by `trailer`. */
const eventStream = <Event extends { readonly type: string }>(
  events: ReadonlyArray<Event>,
  trailer = "",
) => {
  const bytes = new TextEncoder().encode(
    events.map((event) => `event: ${event.type}\r\ndata: ${jsonKey(event)}\r\n\r\n`).join("") +
      trailer,
  );
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 17) {
        controller.enqueue(bytes.slice(offset, offset + 17));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream" },
  });
};

const DELEGATED_TASK = "Review the pull request.";

const responsesToolCall = () => {
  const item = {
    id: "fc_1",
    type: "function_call",
    call_id: "call_1",
    name: "subagent",
    arguments: jsonKey({ task: DELEGATED_TASK }),
    status: "completed",
  };
  return eventStream(
    [
      { type: "response.created", response: { id: "resp_0", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: item.id,
        delta: item.arguments,
      },
      {
        type: "response.function_call_arguments.done",
        output_index: 0,
        item_id: item.id,
        arguments: item.arguments,
      },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.done",
        response: {
          id: "resp_0",
          status: "completed",
          output: [item],
          usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
        },
      },
    ],
    "data: [DONE]\r\n\r\n",
  );
};

const anthropicMessage = (
  block:
    | { readonly type: "text"; readonly text: string }
    | {
        readonly type: "tool_use";
        readonly id: string;
        readonly name: string;
        readonly input: string;
      },
) =>
  eventStream([
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-sonnet-5",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 1 },
      },
    },
    block.type === "text"
      ? { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }
      : {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
        },
    block.type === "text"
      ? { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: block.text } }
      : {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: block.input },
        },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: block.type === "text" ? "end_turn" : "tool_use", stop_sequence: null },
      usage: { output_tokens: 8 },
    },
    { type: "message_stop" },
  ]);

const ToolNames = Schema.Array(Schema.Struct({ name: Schema.String }));

const RequestBody = Schema.fromJsonString(
  Schema.Struct({
    tools: Schema.optionalKey(ToolNames),
    input: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    instructions: Schema.optionalKey(Schema.String),
  }),
);

const AdditionalTools = Schema.Struct({
  type: Schema.Literal("additional_tools"),
  tools: ToolNames,
});

const InstructionItem = Schema.Struct({
  role: Schema.Literals(["system", "developer"]),
  content: Schema.String,
});

/** The tool names a request body declares in `tools` or in `additional_tools` input items. */
const declaredTools = (body: typeof RequestBody.Type) => [
  ...(body.tools ?? []).map(({ name }) => name),
  ...(body.input ?? []).flatMap((item) =>
    Option.match(Schema.decodeUnknownOption(AdditionalTools)(item), {
      onNone: () => [],
      onSome: ({ tools }) => tools.map(({ name }) => name),
    }),
  ),
];

it.live.each([
  {
    route: "openai-codex",
    model: "openai-codex/gpt-5.6-terra",
    credential: "subscription",
    protocol: "openai-responses",
    callId: "call_1",
    toolCall: responsesToolCall,
    final: () => response("response.done"),
  },
  {
    route: "anthropic",
    model: "anthropic/claude-sonnet-5",
    credential: "api-key",
    protocol: "anthropic-messages",
    callId: "toolu_1",
    toolCall: () =>
      anthropicMessage({
        type: "tool_use",
        id: "toolu_1",
        name: "subagent",
        input: jsonKey({ task: DELEGATED_TASK }),
      }),
    final: () => anthropicMessage({ type: "text", text: "Finished through the gateway." }),
  },
] as const)(
  "sends the usine tools on the $route gateway route and round-trips a subagent call",
  ({ model, credential, protocol, callId, toolCall, final }) =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const sent: Array<{ protocol: string; body: string }> = [];
      const access = yield* gatewayModelAccess({
        credential: () => Effect.succeedSome(credential),
        request: (protocol, body) =>
          Effect.sync(() => {
            sent.push({ protocol, body });
            return sent.length === 1 ? toolCall() : final();
          }),
      });
      const original = attemptRequest(`gateway-tools-${protocol}`);
      const request = AttemptRequest.make({
        ...original,
        spec: RunSpec.make({ ...original.spec, parentModel: Option.some(ModelId.make(model)) }),
      });
      const harness = harnessLayer({
        models: access.models,
        credentials: access.credentials,
        defaultModel: Option.none(),
        openStorage: Effect.tryPromise({
          try: () => openNodeSqliteStorage(database),
          catch: (cause) => durableError("open test storage", cause),
        }),
      });
      yield* Effect.gen(function* () {
        const runtime = yield* AttemptRuntime;
        const execution = yield* Effect.forkChild(runtime.execute(request, recordingSink().sink));
        const child = yield* (yield* StubChildren).next.pipe(Effect.timeout("10 seconds"));
        assert.include(child.request.prompt, DELEGATED_TASK);
        yield* child.reply("The child reviewed the pull request.");
        const report = yield* Fiber.join(execution);
        assert.strictEqual(report.message, "Finished through the gateway.");
      }).pipe(
        Effect.provide(
          runtimeLayer.pipe(Layer.provideMerge(harness), Layer.provideMerge(stubChildBackendLayer)),
        ),
      );
      assert.lengthOf(sent, 2);
      for (const message of sent) {
        assert.strictEqual(message.protocol, protocol);
        const body = yield* Schema.decodeEffect(RequestBody)(message.body);
        assert.include(declaredTools(body), "subagent");
        if (protocol === "openai-responses") {
          assert.isNotEmpty(body.instructions);
          const repeated = (body.input ?? []).filter((item) =>
            Option.exists(
              Schema.decodeUnknownOption(InstructionItem)(item),
              ({ content }) => content === body.instructions,
            ),
          );
          assert.lengthOf(repeated, 0);
        }
      }
      assert.include(sent[1]?.body, callId);
      assert.include(sent[1]?.body, "The child reviewed the pull request.");
    }).pipe(Effect.scoped),
);

it.live.each([
  { credential: "api-key", terminal: "response.completed" },
  { credential: "subscription", terminal: "response.completed" },
  { credential: "api-key", terminal: "response.done" },
  { credential: "subscription", terminal: "response.done" },
] as const)(
  "runs a coordinator with a gateway $credential credential and $terminal terminal event and records its pool",
  ({ credential, terminal }) =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const sent: Array<{ protocol: string; body: string }> = [];
      let current: GatewayCredentialKind | undefined = credential;
      const access = yield* gatewayModelAccess({
        credential: () => Effect.succeed(Option.fromUndefinedOr(current)),
        request: (protocol, body) =>
          Effect.sync(() => {
            sent.push({ protocol, body });
            return response(terminal);
          }),
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
        credentials: access.credentials,
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
          { ...access, defaultModel: Option.none() },
          request.spec,
          Option.none(),
        );
        assert.strictEqual(selected.pool, pool);
        const durable = yield* DurableHarness;
        assert.strictEqual(durable.credentials, access.credentials);
        current = undefined;
        const missing = yield* resolveParent(
          { ...access, defaultModel: Option.none() },
          request.spec,
          Option.none(),
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
            input: Schema.Array(Schema.Unknown),
            max_output_tokens: Schema.optionalKey(Schema.Finite),
          }),
        ),
      )(sent[0]?.body);
      assert.strictEqual(body.store, false);
      assert.isNotEmpty(body.instructions);
      assert.notInclude(jsonKey(body.input), body.instructions);
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
      const access = yield* gatewayModelAccess({
        credential: () => Effect.succeedSome("subscription"),
        request: () => Effect.sync(() => response()),
      });
      assert.strictEqual(access.credentials.route, "gateway");
      if (access.credentials.route !== "gateway") return;
      for (const provider of ["anthropic", "openai", "google"]) {
        const authentication = yield* access.credentials.authentication(provider);
        assert.isUndefined(authentication);
      }
      assert.isUndefined(access.models.getProvider("google"));
    }),
);

it.effect("startup reports a missing gateway credential by coordinator provider", () =>
  Effect.gen(function* () {
    const access = yield* gatewayModelAccess({
      credential: () => Effect.succeedNone,
      request: () => Effect.sync(() => response()),
    });
    const failure = yield* resolveParent(
      { ...access, defaultModel: Option.none() },
      {
        parentModel: Option.some(ModelId.make("openai-codex/gpt-5.6-sol")),
        parentEffort: "high",
      },
      Option.none(),
    ).pipe(Effect.flip);
    assert.include(failure.message, 'Gateway credential unavailable for provider "openai-codex"');
  }),
);

it.live("streams without an admin credential lookup and lifts only the initial system prompt", () =>
  Effect.gen(function* () {
    const sent: Array<string> = [];
    const access = yield* gatewayModelAccess({
      credential: () => Effect.die("streaming must not query the admin API"),
      request: (_protocol, body) =>
        Effect.sync(() => {
          sent.push(body);
          return response("response.done");
        }),
    });
    const model = access.models.getModel("openai-codex", "gpt-5.6-sol");
    assert(model !== undefined);
    const answer = yield* Effect.promise(() =>
      access.models.completeSimple(model, {
        messages: [
          { role: "system", content: "Initial coordinator instructions", timestamp: 1 },
          { role: "user", content: "Hello", timestamp: 2 },
          { role: "system", content: "Later instruction update", timestamp: 3 },
        ],
      }),
    );
    assert.strictEqual(answer.stopReason, "stop");
    const payload = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(
        Schema.Struct({
          instructions: Schema.String,
          input: Schema.Array(Schema.Unknown),
        }),
      ),
    )(sent[0]);
    assert.strictEqual(payload.instructions, "Initial coordinator instructions");
    assert.notInclude(jsonKey(payload.input), payload.instructions);
    assert.include(jsonKey(payload.input), "Later instruction update");
    assert.include(jsonKey(payload.input), "Hello");
  }),
);

it.live("passes non-JSON Codex data to the SDK's malformed-event error", () =>
  Effect.gen(function* () {
    const access = yield* gatewayModelAccess({
      credential: () => Effect.succeedSome("subscription"),
      request: () =>
        Effect.sync(
          () =>
            new Response("data: not-json\n\n", {
              headers: { "content-type": "text/event-stream" },
            }),
        ),
    });
    const model = access.models.getModel("openai-codex", "gpt-5.6-sol");
    assert(model !== undefined);
    const answer = yield* Effect.promise(() =>
      access.models.completeSimple(model, {
        messages: [{ role: "user", content: "Hello", timestamp: 1 }],
      }),
    );
    assert.strictEqual(answer.stopReason, "error");
    assert.include(answer.errorMessage ?? "", "malformed server-sent event JSON");
  }),
);

it.effect("selects a gateway-authenticated provider when no parent model is configured", () =>
  Effect.gen(function* () {
    const access = yield* gatewayModelAccess({
      credential: (protocol) =>
        Effect.succeed(
          protocol === "openai-responses" ? Option.some("subscription") : Option.none(),
        ),
      request: () => Effect.die("selection must not send model requests"),
    });
    const selected = yield* resolveParent(
      { ...access, defaultModel: Option.none() },
      {
        parentModel: Option.none(),
        parentEffort: "high",
      },
    );
    assert.strictEqual(selected.ref.provider, "openai-codex");
    assert.strictEqual(selected.pool, "chatgptPlan");
  }),
);
