import { NodeCrypto } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, type AgentSessionEvent, ChildSession } from "@usine/core/agent/session";
import { Interrupt, OperatorMessage, Release, Steer } from "@usine/core/attempt/channel";
import { WorkerName } from "@usine/core/worker";
import { Cause, Effect, Fiber, Layer, Option, Queue, Schema, Stream } from "effect";
import { LocalProcess } from "../../src/child-host/child-host.ts";
import { ChildBackend, ChildRequest, WorkingDirectory } from "../../src/runtime.ts";
import { openCodeChildLayer } from "../../src/harness/opencode/opencode.ts";
import { OpenCodeServer, type OpenCodeConnection } from "../../src/harness/opencode/server.ts";

const request = (model = "openai/test", effort: BrainSpec["effort"] = "off") =>
  ChildRequest.make({
    worker: WorkerName.make("worker-1"),
    machine: Option.none(),
    host: LocalProcess.make(),
    cwd: WorkingDirectory.make("/workspace/repo"),
    environment: {},
    prompt: "Implement the task.",
    session: ChildSession.make({
      id: AgentSessionId.make("parent:child:1"),
      parentId: AgentSessionId.make("parent"),
      agent: AgentName.make("developer"),
      brain: BrainSpec.make({
        harness: Harness.make("opencode"),
        model: ModelId.make(model),
        effort,
      }),
    }),
  });

const fixture = Effect.gen(function* () {
  const events = yield* Queue.make<Schema.Json, Cause.Done>();
  const calls: Array<{ method: string; path: string; body: Schema.Json | undefined }> = [];
  let connections: Schema.Json = [];
  let providerID = "openai";
  let closed = false;
  const connection: OpenCodeConnection = {
    request: (_operation, method, path, body) =>
      Effect.sync(() => {
        calls.push({ method, path, body });
        if (path.startsWith("/api/model"))
          return {
            data: [{ id: "test", providerID, enabled: true, variants: [{ id: "high" }] }],
          };
        if (path.startsWith("/api/integration")) return { data: [{ id: providerID, connections }] };
        if (path === "/api/session") return { data: { id: "ses_test" } };
        return null;
      }),
    events: Stream.concat(
      Stream.succeed<Schema.Json>({ type: "server.connected", data: {} }),
      Stream.fromQueue(events),
    ),
    close: Effect.sync(() => {
      closed = true;
    }),
  };
  const layer = openCodeChildLayer.pipe(
    Layer.provide(Layer.succeed(OpenCodeServer)({ open: () => Effect.succeed(connection) })),
    Layer.provide(NodeCrypto.layer),
  );
  const backend = yield* ChildBackend.pipe(Effect.provide(layer));
  return {
    backend,
    calls,
    events,
    closed: () => closed,
    provider: (id: string) => {
      providerID = id;
    },
    authentication: (value: Schema.Json) => {
      connections = value;
    },
    oauth: () => {
      connections = [{ type: "credential", method: "oauth" }];
    },
    emit: (type: string, data: Record<string, Schema.Json> = {}) =>
      Queue.offer(events, { type, data: { sessionID: "ses_test", ...data } }),
  };
});

describe("OpenCode child", () => {
  it.effect("preserves an outcome marker split across completed text parts", () =>
    Effect.gen(function* () {
      const test = yield* fixture;
      const running = yield* test.backend.launch(request());
      yield* test.emit("session.text.ended", {
        assistantMessageID: "msg_1",
        text: "[usine:blocked]\n",
      });
      yield* test.emit("session.text.ended", {
        assistantMessageID: "msg_1",
        text: "Repository permission denied.",
      });
      yield* test.emit("session.execution.succeeded");
      const error = yield* running.result.pipe(Effect.flip);
      assert.strictEqual(error._tag, "AgentBlockedError");
      assert.strictEqual(error.message, "Repository permission denied.");
    }).pipe(Effect.scoped),
  );

  it.effect("uses the active connection when a stored key and OAuth login coexist", () =>
    Effect.gen(function* () {
      const test = yield* fixture;
      test.authentication([
        { type: "credential", method: "key" },
        { type: "credential", method: "oauth" },
      ]);
      const running = yield* test.backend.launch(request());
      assert.deepStrictEqual(running.session.pool, Option.some("apiKeys"));
    }).pipe(Effect.scoped),
  );

  for (const provider of ["anthropic", "claude-agent", "other"]) {
    it.effect(`refuses an unsupported ${provider} subscription before starting a session`, () =>
      Effect.gen(function* () {
        const test = yield* fixture;
        test.provider(provider);
        test.oauth();
        const error = yield* test.backend.launch(request(`${provider}/test`)).pipe(Effect.flip);
        assert.strictEqual(error._tag, "PoolUnavailableError");
        assert.isFalse(test.calls.some((call) => call.path === "/api/session"));
      }).pipe(Effect.scoped),
    );
  }

  it.effect("maps completed text, tools, usage, and retry recovery into a framed result", () =>
    Effect.gen(function* () {
      const test = yield* fixture;
      const running = yield* test.backend.launch(request());
      const collected = yield* running.events.pipe(Stream.runCollect, Effect.forkChild);
      yield* test.emit("session.text.delta", { delta: "partial" });
      yield* test.emit("session.retry.scheduled", {
        attempt: 1,
        error: { type: "busy", message: "Retry" },
      });
      yield* test.emit("session.tool.input.started", {
        assistantMessageID: "msg_1",
        id: "call_1",
        name: "shell",
      });
      yield* test.emit("session.tool.called", {
        assistantMessageID: "msg_1",
        id: "call_1",
        input: { command: "pwd" },
      });
      yield* test.emit("session.tool.success", {
        assistantMessageID: "msg_1",
        id: "call_1",
        content: [{ type: "text", text: "/workspace/repo" }],
      });
      yield* test.emit("session.step.ended", {
        assistantMessageID: "msg_1",
        cost: 0.25,
        tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 20, write: 3 } },
      });
      yield* test.emit("session.text.ended", { assistantMessageID: "msg_1", text: "Done." });
      yield* test.emit("session.execution.succeeded");
      const result = yield* running.result;
      const events = yield* Fiber.join(collected);
      assert.strictEqual(result.message, "Done.");
      assert.strictEqual(events[0]?._tag, "SessionStarted");
      assert.strictEqual(events.at(-1)?._tag, "SessionFinished");
      assert.deepStrictEqual(
        events.filter((e) => e._tag === "TextOutput").map((e) => e.text),
        ["Done."],
      );
      assert.strictEqual(events.filter((e) => e._tag === "ToolStarted").length, 1);
      assert.strictEqual(events.filter((e) => e._tag === "ToolFinished").length, 1);
      const usage = events.find((e) => e._tag === "SessionTokensUpdated");
      assert(usage !== undefined);
      assert.strictEqual(usage.totalTokens, 20);
      assert.deepStrictEqual(usage.costUsd, Option.some(0.25));
      assert(Option.isSome(usage.breakdown));
      assert.strictEqual(usage.breakdown.value.cachedInput, 20);
      assert.deepStrictEqual(
        events
          .filter((e) => e._tag === "ProviderRetrying" || e._tag === "ProviderRecovered")
          .map((e) => e._tag),
        ["ProviderRetrying", "ProviderRecovered"],
      );
      assert.deepStrictEqual(running.session.pool, Option.some("apiKeys"));
      assert.deepStrictEqual(running.session.endpoint, Option.some("openai"));
      assert.isTrue(test.closed());
    }).pipe(Effect.scoped),
  );

  for (const [model, effort, tag] of [
    ["unknown/test", "off", "UnknownModelError"],
    ["openai/test", "max", "UnsupportedEffortError"],
  ] as const) {
    it.effect(`rejects ${tag} before submitting a prompt`, () =>
      Effect.gen(function* () {
        const test = yield* fixture;
        const error = yield* test.backend.launch(request(model, effort)).pipe(Effect.flip);
        assert.strictEqual(error._tag, tag);
        assert.isFalse(test.calls.some((call) => call.path === "/api/session"));
      }).pipe(Effect.scoped),
    );
  }

  it.effect("records a host ChatGPT login and each gateway credential's billing pool", () =>
    Effect.gen(function* () {
      for (const credential of [
        Option.none<"api-key" | "subscription">(),
        Option.some("api-key" as const),
        Option.some("subscription" as const),
      ]) {
        const test = yield* fixture;
        test.oauth();
        const original = request();
        const running = yield* test.backend.launch(
          ChildRequest.make({
            ...original,
            session: ChildSession.make({ ...original.session, gatewayCredential: credential }),
          }),
        );
        assert.deepStrictEqual(
          running.session.pool,
          Option.some(
            Option.isSome(credential) && credential.value === "api-key" ? "apiKeys" : "chatgptPlan",
          ),
        );
        yield* test.emit("session.text.ended", { assistantMessageID: "msg_1", text: "Done." });
        yield* test.emit("session.execution.succeeded");
        yield* running.result;
      }
    }).pipe(Effect.scoped),
  );

  it.effect("acknowledges queued guidance and resumes a held, paused session", () =>
    Effect.gen(function* () {
      const test = yield* fixture;
      const running = yield* test.backend.launch(request());
      const observed = yield* Queue.make<AgentSessionEvent>();
      yield* running.events.pipe(
        Stream.runForEach((event) => Queue.offer(observed, event)),
        Effect.forkChild,
      );
      const idle = Queue.take(observed).pipe(
        Effect.repeat({ while: (event) => event._tag !== "SessionIdle" }),
      );
      const deliveries: Array<boolean> = [];
      const state = yield* running.intervene(
        OperatorMessage.make({ message: "Guidance" }),
        (value) =>
          Effect.sync(() => {
            deliveries.push(Option.isSome(value));
          }),
      );
      assert.isTrue(state.queued);
      const prompt = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(
        test.calls.at(-1)?.body,
      );
      yield* test.emit("session.inbox.delivered", { inboxID: prompt.id });
      yield* running.intervene(Interrupt.make(), () => Effect.void);
      yield* test.emit("session.execution.interrupted");
      yield* idle;
      const resumed = yield* running.intervene(
        OperatorMessage.make({ message: "Continue" }),
        () => Effect.void,
      );
      assert.isFalse(resumed.paused);
      yield* test.emit("session.text.ended", { assistantMessageID: "msg_2", text: "Updated." });
      yield* test.emit("session.execution.succeeded");
      yield* idle;
      yield* running.intervene(Release.make(), () => Effect.void);
      assert.strictEqual((yield* running.result).message, "Updated.");
      assert.deepStrictEqual(deliveries, [true]);
    }).pipe(Effect.scoped),
  );

  for (const [name, action] of [
    ["steering", Steer],
    ["operator guidance", OperatorMessage],
  ] as const) {
    it.effect(`preserves ${name} accepted before interruption cleanup finishes`, () =>
      Effect.gen(function* () {
        const test = yield* fixture;
        const running = yield* test.backend.launch(request());
        const observed = yield* Queue.make<AgentSessionEvent>();
        yield* running.events.pipe(
          Stream.runForEach((event) => Queue.offer(observed, event)),
          Effect.forkChild,
        );
        yield* running.intervene(Interrupt.make(), () => Effect.void);
        const state = yield* running.intervene(
          action.make({ message: "Continue with the correction" }),
          () => Effect.void,
        );
        assert.isFalse(state.paused);
        yield* test.emit("session.execution.interrupted");
        yield* test.emit("session.text.ended", { assistantMessageID: "msg_2", text: "Updated." });
        yield* Queue.take(observed).pipe(
          Effect.repeat({ while: (event) => event._tag !== "TextOutput" }),
        );
        assert.isFalse(test.closed());
        // Release before completion also catches an old terminal event that made the session idle.
        yield* running.intervene(Release.make(), () => Effect.void);
        assert.isFalse(test.closed());
        yield* test.emit("session.execution.succeeded");
        assert.strictEqual((yield* running.result).message, "Updated.");
      }).pipe(Effect.scoped),
    );
  }

  for (const [type, data, tag] of [
    ["permission.asked", { id: "ask_1" }, "AgentResultError"],
    [
      "session.execution.failed",
      { error: { type: "provider", message: "Failed" } },
      "AgentResultError",
    ],
    ["session.text.ended", { text: 42 }, "SessionOperationError"],
  ] as const) {
    it.effect(`fails promptly on ${type}`, () =>
      Effect.gen(function* () {
        const test = yield* fixture;
        const running = yield* test.backend.launch(request());
        yield* test.emit(type, data);
        assert.strictEqual((yield* running.result.pipe(Effect.flip))._tag, tag);
      }).pipe(Effect.scoped),
    );
  }

  it.effect("reports a disconnected event stream instead of waiting for a result", () =>
    Effect.gen(function* () {
      const test = yield* fixture;
      const running = yield* test.backend.launch(request());
      yield* Queue.end(test.events);
      assert.strictEqual((yield* running.result.pipe(Effect.flip))._tag, "SessionOperationError");
    }).pipe(Effect.scoped),
  );
});
