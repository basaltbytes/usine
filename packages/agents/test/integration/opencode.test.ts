import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { Config, Effect, FileSystem, Layer, Option, Queue, Schema, Stream } from "effect";
import { LocalProcess } from "../../src/child-host/child-host.ts";
import { ChildRequest, WorkingDirectory } from "../../src/runtime.ts";
import { AgentName } from "@usine/core/agent";
import { AgentSessionId, ChildSession } from "@usine/core/agent/session";
import { WorkerName } from "@usine/core/worker";
import { ProbeTarget } from "../../src/harness/runtime.ts";
import { opencode } from "../../src/harness/opencode/descriptor.ts";
import { ChildBackend } from "../../src/runtime.ts";
import {
  openCodeChildLayer,
  openCodeServerLive,
  OpenCodeServer,
  openCodeRuntime,
} from "../../src/harness/opencode/opencode.ts";
import {
  interruptionContract,
  localHost,
  shimHost,
  steeringContract,
  type ContractHost,
} from "./contract.ts";
import { openCodeFixture } from "./opencode-fixture.ts";

const live = openCodeChildLayer.pipe(
  Layer.provideMerge(openCodeServerLive),
  Layer.provideMerge(NodeServices.layer),
);
const configuration = (child: ContractHost) =>
  Effect.gen(function* () {
    const fixture = yield* Config.Boolean("USINE_OPENCODE_CONTRACT_FIXTURE").pipe(
      Config.withDefault(false),
    );
    const environment = fixture
      ? (yield* openCodeFixture).environment
      : {
          OPENCODE_CONFIG_CONTENT: yield* Config.String("OPENCODE_CONFIG_CONTENT").pipe(
            Config.withDefault("{}"),
          ),
        };
    const model = fixture
      ? "fixture/test"
      : yield* Config.String("USINE_OPENCODE_INTEGRATION_MODEL");
    const decoded = yield* Schema.decodeEffect(ModelId)(model);
    return {
      brain: BrainSpec.make({ harness: Harness.make("opencode"), model: decoded, effort: "off" }),
      child: {
        ...child,
        environment: {
          ...child.environment,
          ...environment,
          OPENCODE_CONFIG_CONTENT: environment.OPENCODE_CONFIG_CONTENT,
        },
      },
    };
  });

describe("OpenCode child contract", () => {
  for (const [name, child] of [
    ["locally", localHost],
    ["through SSH forwarding", shimHost],
  ] as const) {
    it.live(
      `reads steering during an active command ${name}`,
      () =>
        Effect.gen(function* () {
          const backend = yield* ChildBackend;
          const configured = yield* configuration(child);
          return yield* steeringContract(backend, configured.brain, configured.child);
        }).pipe(Effect.scoped, Effect.provide(live)),
      210_000,
    );
    it.live(
      `interrupts and stops the active command ${name}`,
      () =>
        Effect.gen(function* () {
          const backend = yield* ChildBackend;
          const configured = yield* configuration(child);
          return yield* interruptionContract(backend, configured.brain, configured.child);
        }).pipe(Effect.scoped, Effect.provide(live)),
      150_000,
    );
  }
});

it.live(
  "ignores checkout configuration and reports a headless ask before running the command",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const server = yield* OpenCodeServer;
      const { environment } = yield* openCodeFixture;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "usine-opencode-isolation-" });
      yield* fs.makeDirectory(`${cwd}/.opencode/plugins`, { recursive: true });
      yield* fs.writeFileString(
        `${cwd}/opencode.json`,
        '{"providers":{"checkout-marker":{"package":"missing-package"}}}',
      );
      yield* fs.writeFileString(
        `${cwd}/.opencode/plugins/bad.ts`,
        'throw new Error("checkout plugin executed")',
      );
      const connection = yield* server.open({
        cwd: WorkingDirectory.make(cwd),
        sessionId: Option.none(),
        host: LocalProcess.make(),
        environment: { ...localHost.environment, ...environment },
      });
      const config = yield* connection.request(
        "launch",
        "GET",
        `/api/config?directory=${encodeURIComponent(cwd)}`,
      );
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(config);
      assert.notInclude(encoded, "checkout-marker");
      const created = yield* connection.request("launch", "POST", "/api/session", {
        location: { directory: cwd },
        model: { providerID: "fixture", id: "test" },
        permissions: [{ action: "*", resource: "*", effect: "ask" }],
      });
      const { data: saved } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }),
      )(created);
      const events = yield* Queue.make<{ readonly type: string }>();
      yield* connection.events.pipe(
        Stream.mapEffect((raw) =>
          Schema.decodeUnknownEffect(Schema.Struct({ type: Schema.String }))(raw),
        ),
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      yield* Queue.take(events);
      yield* connection.request("launch", "POST", `/api/session/${saved.id}/prompt`, {
        text: "Run the waiting command",
        delivery: "steer",
      });
      yield* Queue.take(events).pipe(
        Effect.repeat({ while: (event) => event.type !== "permission.asked" }),
        Effect.timeout("15 seconds"),
      );
      const started = yield* fs.exists(`${cwd}/command.pid`);
      assert.isFalse(started);
      yield* connection.request("interrupt", "POST", `/api/session/${saved.id}/interrupt`);
      yield* connection.close;
    }).pipe(Effect.scoped, Effect.provide(live)),
  30_000,
);

for (const kind of ["api-key", "subscription"] as const) {
  it.live(
    `sends the gateway Responses request and records the ${kind} pool`,
    () =>
      Effect.gen(function* () {
        const fixture = yield* openCodeFixture;
        const fs = yield* FileSystem.FileSystem;
        const backend = yield* ChildBackend;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "usine-opencode-gateway-" });
        const credential = opencode.worker.credential;
        assert(Option.isSome(credential));
        const wiring = credential.value.gateway.render(
          fixture.baseUrl.replace(/\/v1$/u, "/openai-responses/v1"),
          fixture.environment.XDG_DATA_HOME,
        );
        const running = yield* backend.launch(
          ChildRequest.make({
            cwd: WorkingDirectory.make(cwd),
            host: LocalProcess.make(),
            worker: WorkerName.make("worker-1"),
            machine: Option.none(),
            environment: {
              ...localHost.environment,
              ...fixture.environment,
              ...wiring.environment,
              USINE_GATEWAY_TOKEN: "fixture",
            },
            session: ChildSession.make({
              id: AgentSessionId.make("parent:gateway:child:1"),
              parentId: AgentSessionId.make("parent"),
              agent: AgentName.make("developer"),
              gatewayCredential: Option.some(kind),
              brain: BrainSpec.make({
                harness: opencode.id,
                model: ModelId.make("openai/gpt-6-astra"),
                effort: "off",
              }),
            }),
            prompt: "Reply with gateway-ok.",
          }),
        );
        const sent = yield* Queue.take(fixture.requests).pipe(Effect.timeout("15 seconds"));
        assert.strictEqual(sent.path, "/openai-responses/v1/responses");
        const body = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            model: Schema.String,
            store: Schema.Boolean,
            stream: Schema.Boolean,
            instructions: Schema.String,
          }),
        )(sent.body);
        assert.strictEqual(body.model, "gpt-6-astra");
        assert.isFalse(body.store);
        assert.isTrue(body.stream);
        const result = yield* running.result.pipe(Effect.timeout("15 seconds"));
        assert.strictEqual(result.message, "gateway-ok");
        assert.deepStrictEqual(
          running.session.pool,
          Option.some(kind === "subscription" ? "chatgptPlan" : "apiKeys"),
        );
      }).pipe(Effect.scoped, Effect.provide(live)),
    30_000,
  );
}

it.live(
  "preflights an enabled host model without sending a provider request",
  () =>
    Effect.gen(function* () {
      const fixture = yield* openCodeFixture;
      const runtime = yield* openCodeRuntime;
      const readiness = yield* runtime.preflight(
        BrainSpec.make({
          harness: opencode.id,
          model: ModelId.make("fixture/test"),
          effort: "off",
        }),
        ProbeTarget.make({
          host: LocalProcess.make(),
          worker: WorkerName.make("worker-1"),
          machine: Option.none(),
          credential: "host-login",
          environment: { ...localHost.environment, ...fixture.environment },
        }),
      );
      assert.strictEqual(readiness._tag, "HarnessReady");
      const requests = yield* Queue.clear(fixture.requests);
      assert.deepStrictEqual(requests, []);
    }).pipe(Effect.scoped, Effect.provide(live)),
  30_000,
);
