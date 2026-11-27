import { assert, describe, it } from "@effect/vitest";
import { RemoteShell } from "@usine/agents/child-host";
import {
  apiKeys,
  CapabilityProfile,
  catalog,
  CredentialWiring,
  HarnessCatalog,
  HarnessCredential,
  HarnessDescriptor,
  HarnessPool,
  WorkerRequirements,
} from "@usine/agents/harness";
import { harnessesLiveFrom } from "@usine/agents/harness/node";
import { Agent } from "@usine/core/agent";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import {
  ApiKeyCredential,
  GatewaySlot,
  GatewayVariable,
  HeaderName,
  KeyHeader,
  ModelProvider,
  ModelProviderCatalog,
  ModelProviderId,
  modelProviders,
  opencodeGo,
  ProviderProtocol,
  RoutePattern,
  UpstreamBase,
  WireProtocol,
} from "@usine/core/agent/provider";
import { jsonKey } from "@usine/core/json-key";
import type { AttemptRequest } from "@usine/durable/attempt-runtime";
import { completes, type StubParent } from "@usine/durable/testing";
import { ApiKey, GatewayProxy, LlmProvider, type LlmProviders } from "@usine/gateway";
import { Array as Arr, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse, HttpServerRequest, HttpServerResponse } from "effect/http";
import { CheckoutRequest, Executor } from "../../../src/executor.ts";
import {
  aloneOnItem,
  capturedLogs,
  fakeMachine,
  mintingProvider,
  request,
  TEST_AGENT,
  WORKER,
  stdinValue,
} from "../support.ts";
import { fakeGateway, gatewayAddress, gatewayRuntime } from "./support.ts";

const PLAN_KEY = "plan-key-for-executor-tests-0123456789";

const chat = ProviderProtocol.make({
  protocol: WireProtocol.make("openai-chat-completions"),
  upstream: UpstreamBase.make("https://plan.test/openai/v1"),
  routes: [RoutePattern.make("/chat/completions")],
  key: KeyHeader.make({ header: HeaderName.make("authorization"), scheme: "bearer" }),
});

const messages = ProviderProtocol.make({
  protocol: WireProtocol.make("anthropic-messages"),
  upstream: UpstreamBase.make("https://plan.test/anthropic/v1"),
  routes: [RoutePattern.make("/messages")],
  key: KeyHeader.make({ header: HeaderName.make("x-api-key"), scheme: "none" }),
});

/**
 * A provider that only this test defines: one static key for two protocols, which take the key in
 * different headers, and one header that passes to the upstream.
 */
const plan = ModelProvider.make({
  id: ModelProviderId.make("test-plan"),
  slot: GatewaySlot.make("test-plan"),
  label: "Test plan",
  protocols: [chat, messages],
  credentials: [ApiKeyCredential.make({ variable: GatewayVariable.make("TEST_PLAN_API_KEY") })],
  passThrough: Option.some([HeaderName.make("x-plan-session")]),
});

const claude = catalog.descriptors.find(({ id }) => id === "claude");
assert(claude !== undefined && Option.isSome(claude.worker.credential));
const wiring = CredentialWiring.make({
  tokenVariable: "PLAN_GATEWAY_TOKEN",
  environment: { PLAN_BASE_URL: "{{baseUrl}}" },
  files: {},
});

/**
 * A harness that only this test registers, which uses the test plan through the gateway. It offers
 * Claude's routes but the api-key route, which can't reach the plan's two upstreams.
 */
const planClient = HarnessDescriptor.make({
  ...claude,
  id: Harness.make("plan-client"),
  label: "Plan client",
  capabilities: Arr.map(claude.capabilities, (profile) => {
    const credentials = profile.credentials.filter((route) => route !== "api-key");
    assert(Arr.isReadonlyArrayNonEmpty(credentials));
    return CapabilityProfile.make({ ...profile, credentials });
  }),
  worker: WorkerRequirements.make({
    ...claude.worker,
    credential: Option.some(
      HarnessCredential.make({
        ...claude.worker.credential.value,
        gateway: wiring,
        apiKey: CredentialWiring.make({ ...wiring, tokenVariable: "PLAN_API_KEY" }),
        cloudflare: CredentialWiring.make({ ...wiring, tokenVariable: "PLAN_API_KEY" }),
      }),
    ),
  }),
  providers: [plan],
  pools: [HarnessPool.make({ pool: apiKeys, routes: ["gateway-api-key"] })],
});

const planHarnesses = harnessesLiveFrom(
  HarnessCatalog.make({ descriptors: [...catalog.descriptors, planClient] }),
  (runtimes) => {
    const runtime = runtimes.find(({ id }) => id === "claude");
    assert(runtime !== undefined);
    return [...runtimes, { ...runtime, id: planClient.id }];
  },
).pipe(Layer.orDie);

const PLAN_BRAIN = BrainSpec.make({ ...TEST_AGENT.brain, harness: planClient.id });

const keyed: LlmProviders = {
  [plan.slot]: LlmProvider.make({
    upstream: Option.none(),
    credential: ApiKey.make({ key: Redacted.make(PLAN_KEY) }),
  }),
};

/** Returns the providers of `modelProviders` and `providers`, as a gateway's catalog. */
const servingAlso = (...providers: ReadonlyArray<ModelProvider>) =>
  ModelProviderCatalog.make({ providers: [...modelProviders.providers, ...providers] });

const sink = {
  append: () => Effect.void,
  salvage: () => Effect.void,
  comments: () => Effect.void,
  outOfMemory: () => Effect.void,
  transcript: Effect.succeed([]),
  windows: aloneOnItem(),
};

interface Upstream {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

describe("a provider slot that only the test's catalog declares", () => {
  it.effect(
    "wires an attempt to the slot with only a caller token, and the gateway sends the key in each protocol's header",
    () => {
      const machine = fakeMachine();
      const gateway = fakeGateway(machine, keyed, servingAlso(plan));
      const upstream: Array<Upstream> = [];
      const proxy = GatewayProxy.layer.pipe(
        Layer.provide(
          Layer.succeed(HttpClient.HttpClient)(
            HttpClient.make((sent) => {
              upstream.push({ url: sent.url, headers: sent.headers });
              return Effect.succeed(HttpClientResponse.fromWeb(sent, new Response("answer")));
            }),
          ),
        ),
        Layer.provide(gateway.layer),
      );
      const logs = capturedLogs();
      let given: AttemptRequest | undefined;
      let handler: GatewayProxy["Service"] | undefined;
      const statuses: Array<number> = [];
      /** Sends a request from the attempt to `path` on `llm.gw.test`. */
      const send = (path: string, headers: Readonly<Record<string, string>>) =>
        Effect.suspend(() =>
          handler === undefined
            ? Effect.die(new Error("the test has no gateway proxy"))
            : handler.handle.pipe(
                Effect.provideService(
                  HttpServerRequest.HttpServerRequest,
                  HttpServerRequest.fromWeb(
                    new Request(`http://llm.gw.test${path}`, {
                      method: "POST",
                      headers: { ...headers, host: "llm.gw.test" },
                      body: '{"model":"plan-model"}',
                    }),
                  ),
                ),
                Effect.map((response) => statuses.push(HttpServerResponse.toWeb(response).status)),
              ),
        );
      // While the attempt runs, its children call the slot with what the executor gave them.
      const parent: StubParent = (context) =>
        Effect.gen(function* () {
          given = context.request;
          assert(Schema.is(RemoteShell)(given.host));
          const token = stdinValue(given.host, "PLAN_GATEWAY_TOKEN");
          const base = new URL(given.environment.PLAN_BASE_URL ?? "").pathname;
          yield* send(`${base}/chat/completions`, {
            authorization: `Bearer ${token}`,
            "x-plan-session": "session-1",
          });
          yield* send(`${base}/messages`, { "x-api-key": token, "x-plan-session": "session-1" });
          yield* send(`${base}/v1/files`, { authorization: `Bearer ${token}` });
          return yield* completes(context);
        });
      return Effect.gen(function* () {
        handler = yield* GatewayProxy;
        const executor = yield* Executor;
        yield* executor.preflight(WORKER, [PLAN_BRAIN], 1);
        yield* (yield* executor.prepare(
          CheckoutRequest.make({
            ...request,
            agent: Agent.make({ ...TEST_AGENT, brain: PLAN_BRAIN }),
          }),
        )).launch(sink);
        assert(given !== undefined && Schema.is(RemoteShell)(given.host));
        const token = stdinValue(given.host, "PLAN_GATEWAY_TOKEN");
        assert.strictEqual(given.environment.PLAN_BASE_URL, "http://llm.gw.test/test-plan");
        assert.notProperty(given.host.sshEnvironment, "PLAN_GATEWAY_TOKEN");
        assert.notInclude(jsonKey(given.environment), token);
        const credential = yield* given.gatewayCredential;
        assert.deepStrictEqual(credential, Option.some("api-key"));

        assert.deepStrictEqual(statuses, [200, 200, 404]);
        assert.deepStrictEqual(
          upstream.map(({ url, headers }) => [
            url,
            headers.authorization,
            headers["x-api-key"],
            headers["x-plan-session"],
          ]),
          [
            [
              "https://plan.test/openai/v1/chat/completions",
              `Bearer ${PLAN_KEY}`,
              undefined,
              "session-1",
            ],
            ["https://plan.test/anthropic/v1/messages", undefined, PLAN_KEY, "session-1"],
          ],
        );
        for (const text of [
          jsonKey(given.environment),
          jsonKey(
            Object.fromEntries(
              Object.entries(given.host.stdinEnvironment ?? {}).map(([name, value]) => [
                name,
                Redacted.value(value),
              ]),
            ),
          ),
          given.host.ssh.args.join(" "),
          logs.lines.join("\n"),
          [...machine.state.files.values()].join("\n"),
          machine.state.calls.map(({ command }) => command.args.join(" ")).join("\n"),
        ])
          assert.notInclude(text, PLAN_KEY);
      }).pipe(
        Effect.provide([
          gatewayRuntime(machine, mintingProvider(), gateway, {
            address: gatewayAddress({ llmProviders: ["test-plan"] }),
            parent,
            harnesses: planHarnesses,
          }),
          proxy,
          logs.layer,
        ]),
      );
    },
  );

  it.effect(
    "fails preflight with an upgrade of the gateway when the gateway is older than the slot or one of its routes",
    () => {
      const machine = fakeMachine();
      const withoutMessages = ModelProvider.make({ ...plan, protocols: [chat] });
      const olderRoutes = fakeGateway(machine, keyed, servingAlso(withoutMessages));
      const beforeCatalog = fakeGateway(machine, {}, modelProviders);
      beforeCatalog.switches.reportsSlots = false;
      const withoutSlot = fakeGateway(machine, {}, modelProviders);
      const preflight = (gateway: ReturnType<typeof fakeGateway>) =>
        Effect.gen(function* () {
          const executor = yield* Executor;
          return yield* executor.preflight(WORKER, [PLAN_BRAIN], 1).pipe(Effect.flip);
        }).pipe(
          Effect.provide(
            gatewayRuntime(machine, mintingProvider(), gateway, {
              address: gatewayAddress({ llmProviders: ["test-plan"] }),
              harnesses: planHarnesses,
            }),
          ),
        );
      return Effect.gen(function* () {
        const routes = yield* preflight(olderRoutes);
        assert(routes._tag === "WorkerCapabilityError");
        assert.strictEqual(
          routes.message,
          "Gateway usine-gateway serves the Test plan slot test-plan without /messages, which this orchestrator's harnesses call. Upgrade @usine/gateway on it to the release that matches the orchestrator.",
        );
        const slot = yield* preflight(withoutSlot);
        assert(slot._tag === "WorkerCapabilityError");
        assert.strictEqual(
          slot.message,
          'Gateway usine-gateway doesn\'t serve the Test plan slot test-plan, which the llm_providers of SSH worker "eu-one" lists, so it is older than this orchestrator. Upgrade @usine/gateway on it to the release that matches the orchestrator.',
        );
        const unreported = yield* preflight(beforeCatalog);
        assert(unreported._tag === "WorkerCapabilityError");
        assert.include(
          unreported.message,
          "if its release predates test-plan, upgrade @usine/gateway on it first",
        );
      });
    },
  );

  it.effect(
    "reads the slot's credential from providers when the gateway reports slots without credentials",
    () => {
      const machine = fakeMachine();
      const gateway = fakeGateway(machine, keyed, servingAlso(plan));
      gateway.switches.reportsSlotCredentials = false;
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const report = yield* executor.preflight(WORKER, [PLAN_BRAIN], 1);
        assert.deepStrictEqual(report.gatewayUpgrade, Option.none());
      }).pipe(
        Effect.provide(
          gatewayRuntime(machine, mintingProvider(), gateway, {
            address: gatewayAddress({ llmProviders: ["test-plan"] }),
            harnesses: planHarnesses,
          }),
        ),
      );
    },
  );

  it.effect(
    "works with a gateway newer than the orchestrator, which serves more slots and routes",
    () => {
      const machine = fakeMachine();
      const later = ModelProvider.make({
        ...plan,
        id: ModelProviderId.make("later-plan"),
        slot: GatewaySlot.make("later-plan"),
        label: "Later plan",
        credentials: [
          ApiKeyCredential.make({ variable: GatewayVariable.make("LATER_PLAN_API_KEY") }),
        ],
      });
      const widened = ModelProvider.make({
        ...plan,
        protocols: [
          ProviderProtocol.make({
            ...chat,
            routes: [...chat.routes, RoutePattern.make("/chat/completions/{id}")],
          }),
          messages,
        ],
      });
      const gateway = fakeGateway(
        machine,
        { ...keyed, [later.slot]: keyed[plan.slot] ?? assert.fail("no test-plan key") },
        servingAlso(widened, later),
      );
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const report = yield* executor.preflight(WORKER, [PLAN_BRAIN], 1);
        assert.deepStrictEqual(report.gatewayUpgrade, Option.none());
      }).pipe(
        Effect.provide(
          gatewayRuntime(machine, mintingProvider(), gateway, {
            address: gatewayAddress({ llmProviders: ["test-plan"] }),
            harnesses: planHarnesses,
          }),
        ),
      );
    },
  );
});

const GO_KEY = "go-key-for-executor-tests-0123456789";

/** OpenCode on its own descriptor, whose preflight runs Claude's runtime on the fake machine. */
const goHarnesses = harnessesLiveFrom(catalog, (runtimes) => {
  const runtime = runtimes.find(({ id }) => id === "claude");
  assert(runtime !== undefined);
  return runtimes.map((each) => (each.id === "opencode" ? { ...runtime, id: each.id } : each));
}).pipe(Layer.orDie);

const GO_BRAIN = BrainSpec.make({
  harness: Harness.make("opencode"),
  model: ModelId.make("opencode-go/glm-5.3"),
  effort: "low",
});

describe("the OpenCode Go slot", () => {
  it.effect(
    "gives an OpenCode attempt the slot's URL and only a caller token, which the gateway swaps for the plan's key",
    () => {
      const machine = fakeMachine();
      const gateway = fakeGateway(machine, {
        [opencodeGo.slot]: LlmProvider.make({
          upstream: Option.none(),
          credential: ApiKey.make({ key: Redacted.make(GO_KEY) }),
        }),
      });
      const upstream: Array<Upstream> = [];
      const proxy = GatewayProxy.layer.pipe(
        Layer.provide(
          Layer.succeed(HttpClient.HttpClient)(
            HttpClient.make((sent) => {
              upstream.push({ url: sent.url, headers: sent.headers });
              return Effect.succeed(HttpClientResponse.fromWeb(sent, new Response("answer")));
            }),
          ),
        ),
        Layer.provide(gateway.layer),
      );
      const logs = capturedLogs();
      let given: AttemptRequest | undefined;
      let handler: GatewayProxy["Service"] | undefined;
      const statuses: Array<number> = [];
      const parent: StubParent = (context) =>
        Effect.gen(function* () {
          given = context.request;
          assert(Schema.is(RemoteShell)(given.host));
          const token = stdinValue(given.host, "USINE_GATEWAY_TOKEN");
          const base = new URL(given.environment.USINE_OPENCODE_GO_BASE_URL ?? "").pathname;
          const proxied = handler;
          assert(proxied !== undefined);
          const response = yield* proxied.handle.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(
                new Request(`http://llm.gw.test${base}/chat/completions`, {
                  method: "POST",
                  headers: {
                    authorization: `Bearer ${token}`,
                    "x-opencode-session-id": "ses_1",
                    host: "llm.gw.test",
                  },
                  body: '{"model":"glm-5.3"}',
                }),
              ),
            ),
          );
          statuses.push(HttpServerResponse.toWeb(response).status);
          return yield* completes(context);
        });
      return Effect.gen(function* () {
        handler = yield* GatewayProxy;
        const executor = yield* Executor;
        yield* executor.preflight(WORKER, [GO_BRAIN], 1);
        yield* (yield* executor.prepare(
          CheckoutRequest.make({
            ...request,
            agent: Agent.make({ ...TEST_AGENT, brain: GO_BRAIN }),
          }),
        )).launch(sink);
        assert(given !== undefined && Schema.is(RemoteShell)(given.host));
        const token = stdinValue(given.host, "USINE_GATEWAY_TOKEN");
        assert.strictEqual(
          given.environment.USINE_OPENCODE_GO_BASE_URL,
          "http://llm.gw.test/opencode-go",
        );
        // The gateway holds no OpenAI key, so OpenCode gets no OpenAI slot.
        assert.notProperty(given.environment, "USINE_OPENCODE_BASE_URL");
        assert.notProperty(given.environment, "OPENAI_API_KEY");
        assert.notProperty(given.host.stdinEnvironment ?? {}, "OPENAI_API_KEY");
        assert.notProperty(given.host.sshEnvironment, "USINE_GATEWAY_TOKEN");
        assert.notInclude(jsonKey(given.environment), token);
        const credential = yield* given.gatewayCredential;
        assert.deepStrictEqual(credential, Option.some("api-key"));
        assert.deepStrictEqual(statuses, [200]);
        assert.deepStrictEqual(
          upstream.map(({ url, headers }) => [
            url,
            headers.authorization,
            headers["x-opencode-session-id"],
          ]),
          [
            [
              "https://opencode.ai/inference/go/openai/v1/chat/completions",
              `Bearer ${GO_KEY}`,
              "ses_1",
            ],
          ],
        );
        for (const text of [
          jsonKey(given.environment),
          given.host.ssh.args.join(" "),
          logs.lines.join("\n"),
          [...machine.state.files.values()].join("\n"),
        ])
          assert.notInclude(text, GO_KEY);
      }).pipe(
        Effect.provide([
          gatewayRuntime(machine, mintingProvider(), gateway, {
            address: gatewayAddress({ llmProviders: ["opencode-go"] }),
            parent,
            harnesses: goHarnesses,
          }),
          proxy,
          logs.layer,
        ]),
      );
    },
  );
});
