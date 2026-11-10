import { harnessesLive } from "@usine/agents/harness/node";
import { jsonKey } from "@usine/core/json-key";
import { MACHINE_RUN } from "./fixtures.ts";
import { AttemptId } from "@usine/core/attempt";
import { remoteCommandsFor } from "../../../src/remote/commands.ts";
import { assert, describe, it } from "@effect/vitest";
import { ExecShell, RemoteShell } from "@usine/agents/child-host";
import { Agent } from "@usine/core/agent";
import { Harness, BrainSpec, ModelId } from "@usine/core/agent/brain";
import { RunId } from "@usine/core/run";
import {
  BoatSnapshotName,
  BoxdEgressEntry,
  GatewayDomain,
  SshIdentityFile,
  SshDestination,
  TailnetAddress,
} from "@usine/core/worker";
import { completes, StubStorage, stubAttemptRuntime } from "@usine/durable/testing";
import {
  AnthropicProvider,
  AnthropicSubscriptionToken,
  ChatGptLogin,
  HostFilePath,
  OpenAiProvider,
  UpstreamBase,
} from "@usine/gateway";
import { Deferred, Effect, Fiber, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import {
  CheckoutRequest,
  hostLoginLockLayer,
  Executor,
  WorkerMachines,
} from "../../../src/executor.ts";
import type { BoatTailnet, SshWorkerAddress } from "../../../src/ssh/model.ts";
import { tailscaleClientFor } from "../../../src/ssh/provisioner/tailnet/client.ts";
import { boxdDriverFor } from "../../../src/ssh/provisioner/boxd.ts";
import { boatDriverFor } from "../../../src/ssh/provisioner/boat.ts";
import { layer as sshLayer } from "../../../src/ssh/ssh.ts";
import { fakeGateway, gatewayAddress } from "../gateway/support.ts";
import {
  aloneOnItem,
  fakeMachine,
  INSTANCE,
  INSTANCE_ID,
  mintingProvider,
  request,
  TEST_AGENT,
  TOKEN_PREFIX,
  WORKER,
} from "../support.ts";
import { BOAT_TEST_API, fakeProviders } from "./fake-providers.ts";
import { boatSettings, boxdSettings } from "./support.ts";

const tailnet: BoatTailnet = {
  gatewayAddress: TailnetAddress.make("100.64.0.2"),
  clientId: Redacted.make("test-client"),
  clientSecret: Redacted.make("test-client-secret"),
};

const fakeTailnet = () => {
  const calls: Array<{ method: string; path: string; body: string }> = [];
  const state = { refuseKeys: false, gatewayAnswers: true };
  const over = <E, R>(underlying: Layer.Layer<HttpClient.HttpClient, E, R>) =>
    Layer.effect(
      HttpClient.HttpClient,
      Effect.gen(function* () {
        const fallback = yield* HttpClient.HttpClient;
        return HttpClient.make((request, url) => {
          if (url.hostname !== "api.tailscale.com" && url.hostname !== tailnet.gatewayAddress)
            return fallback.execute(request);
          calls.push({
            method: request.method,
            path: url.pathname,
            body:
              request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
          });
          const response =
            url.hostname === tailnet.gatewayAddress
              ? new Response("", {
                  status: 401,
                  headers:
                    state.gatewayAnswers && request.headers.host === "git.gw.test"
                      ? { "x-usine-gateway-refusal": "missing-caller-token" }
                      : {},
                })
              : url.pathname.endsWith("/oauth/token")
                ? Response.json({ access_token: "test-access-token" })
                : request.method === "DELETE"
                  ? Response.json({})
                  : state.refuseKeys
                    ? Response.json(
                        { error: "test-client-secret must not appear in an error" },
                        { status: 403 },
                      )
                    : Response.json({ id: "key-id", key: "tskey-auth-test" });
          return Effect.succeed(HttpClientResponse.fromWeb(request, response));
        });
      }),
    ).pipe(Layer.provide(underlying));
  const layer = over(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die(new Error("unexpected HTTP request"))),
    ),
  );
  return { calls, state, over, layer };
};

const providers = {
  "anthropic-messages": Option.some(
    AnthropicProvider.make({
      upstream: UpstreamBase.make("https://api.anthropic.com"),
      credential: AnthropicSubscriptionToken.make({ token: Redacted.make("sk-ant-oat01-test") }),
    }),
  ),
  "openai-responses": Option.some(
    OpenAiProvider.make({
      upstream: UpstreamBase.make("https://api.openai.com"),
      credential: ChatGptLogin.make({
        authFile: HostFilePath.make("/gateway/auth.json"),
        tokenUrl: UpstreamBase.make("https://auth.openai.com/oauth/token"),
      }),
    }),
  ),
};

const boatAddress: SshWorkerAddress = {
  ...gatewayAddress({ llmProviders: ["anthropic-messages", "openai-responses"] }),
  port: Option.none(),
  identityFile: Option.some(SshIdentityFile.make("/keys/boat")),
  machine: {
    _tag: "Provisioned",
    provisioner: boatSettings({
      snapshot: Option.some(BoatSnapshotName.make("usine-attempt")),
      tailnet: Option.some(tailnet),
      apiKeys: { anthropic: Option.none(), openai: Option.none() },
    }),
  },
};
const sink = {
  append: () => Effect.void,
  salvage: () => Effect.void,
  comments: () => Effect.void,
  outOfMemory: () => Effect.void,
  transcript: Effect.succeed([]),
  windows: aloneOnItem(),
};

const boxdAddress: SshWorkerAddress = {
  ...boatAddress,
  identityFile: Option.none(),
  machine: {
    _tag: "Provisioned",
    provisioner: boxdSettings({
      tailnet: Option.some(tailnet),
      apiKeys: { anthropic: Option.none(), openai: Option.none() },
    }),
  },
};
describe("Provisioner tailnet credentials", () => {
  it.effect("revokes and wipes the auth key when a join is interrupted", () => {
    const api = fakeTailnet();
    return Effect.gen(function* () {
      const started = yield* Deferred.make<Redacted.Redacted<string>>();
      const client = yield* tailscaleClientFor(WORKER, tailnet);
      const joining = yield* client
        .withKey((key) => Deferred.succeed(started, key).pipe(Effect.andThen(Effect.never)))
        .pipe(Effect.forkChild);
      const key = yield* Deferred.await(started);
      yield* Fiber.interrupt(joining);
      assert.strictEqual(api.calls.filter((call) => call.method === "DELETE").length, 1);
      assert.throws(() => Redacted.value(key));
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("scrubs an auth key echoed by a failed SSH command before creating its error", () => {
    const machine = fakeMachine();
    machine.state.tailscaleJoin = "refused";
    return Effect.gen(function* () {
      const commands = yield* remoteCommandsFor;
      const shell = commands.shellFor(
        { command: "ssh", args: [] },
        SshDestination.make("user@boat"),
      );
      const error = yield* commands
        .runWithInput(
          "prepare",
          shell,
          "sudo",
          ["tailscale", "up"],
          Redacted.make("tskey-echo-test"),
        )
        .pipe(Effect.flip);
      assert.notInclude(String(error.cause), "tskey-echo-test");
      assert.include(String(error.cause), "[REDACTED]");
    }).pipe(Effect.scoped, Effect.provide(machine.layer));
  });

  it.effect(
    "creates only preauthorized ephemeral single-use keys and revokes them on failure",
    () => {
      const api = fakeTailnet();
      return Effect.gen(function* () {
        const client = yield* tailscaleClientFor(WORKER, tailnet);
        yield* client.withKey(() => Effect.fail("join failed")).pipe(Effect.flip);
        const creation = api.calls.find(
          (call) => call.method === "POST" && call.path.endsWith("/keys"),
        );
        assert(creation !== undefined);
        const valueDecoded1 = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.JsonObject))(
          creation.body,
        );
        assert.deepInclude(valueDecoded1, {
          capabilities: {
            devices: {
              create: {
                reusable: false,
                ephemeral: true,
                preauthorized: true,
                tags: ["tag:usine-attempt"],
              },
            },
          },
          expirySeconds: 600,
        });
        assert.isTrue(api.calls.some((call) => call.method === "DELETE"));
        api.state.refuseKeys = true;
        const error = yield* client.withKey(() => Effect.void).pipe(Effect.flip);
        assert.include(error.message, "HTTP 403");
        const json1 = jsonKey(error);
        assert.notInclude(json1, "test-client-secret");
        yield* client.verifyGateway(GatewayDomain.make("gw.test"));
        api.state.gatewayAnswers = false;

        assert.include(
          (yield* client.verifyGateway(GatewayDomain.make("gw.test")).pipe(Effect.flip)).message,
          "missing caller token",
        );
      }).pipe(Effect.provide(api.layer));
    },
  );
});

const boxdEgressAddress: SshWorkerAddress = {
  ...boxdAddress,
  machine: {
    _tag: "Provisioned",
    provisioner: boxdSettings({
      tailnet: Option.some(tailnet),
      apiKeys: { anthropic: Option.none(), openai: Option.none() },
      egress: Option.some(
        ["*.tailscale.com", "registry.npmjs.org"].map((entry) => BoxdEgressEntry.make(entry)),
      ),
    }),
  },
};

for (const address of [boatAddress, boxdAddress, boxdEgressAddress]) {
  assert(address.machine._tag === "Provisioned");
  const provider = address.machine.provisioner.provider;
  const restricted =
    address.machine.provisioner.provider === "boxd" &&
    Option.isSome(address.machine.provisioner.egress);
  describe(`${provider}${restricted ? " with an egress allowlist" : ""} tailnet`, () => {
    it.live(
      `deletes an orphan ${provider} machine after a restart without needing tailnet access`,
      () => {
        const machine = fakeMachine();
        machine.state.localFiles.set("/keys/boat.pub", "ssh-ed25519 AAAATest");
        machine.state.reachable = false;
        const boat = fakeProviders();
        const api = fakeTailnet();
        const gateway = fakeGateway(machine, providers);
        const layer = sshLayer({
          workers: [address],
          instance: INSTANCE,
          instanceId: INSTANCE_ID,
          boxdClient: boat.boxdClient,
          boxdExec: boat.boxdExecOn(machine),
          providerEndpoints: { boat: BOAT_TEST_API },
        }).pipe(
          Layer.provide(harnessesLive),
          Layer.provide(machine.layer),
          Layer.provide(mintingProvider().layer),
          Layer.provide(stubAttemptRuntime(new StubStorage(), completes)),
          Layer.provide(hostLoginLockLayer),
          Layer.provide(boat.over(api.over(gateway.layer))),
        );
        return Effect.gen(function* () {
          const driver = yield* provider === "boxd"
            ? boxdDriverFor(WORKER, boxdSettings())
            : boatDriverFor(WORKER, boatSettings(), "ssh-ed25519 AAAATest", BOAT_TEST_API);
          yield* driver.create("earlier-create", {
            instance: INSTANCE,
            worker: WORKER,
            run: RunId.make("earlier-run"),
            process: "earlier-process",
            attempt: AttemptId.make("earlier-run/execute/1"),
            attempts: 1,
          });
          assert.strictEqual(
            (provider === "boxd" ? boat.boxd.machines : boat.boat.sandboxes).size,
            1,
          );
          yield* (yield* WorkerMachines).sweep;
          assert.strictEqual(
            (provider === "boxd" ? boat.boxd.machines : boat.boat.sandboxes).size,
            0,
          );
          assert.lengthOf(api.calls, 0);
        }).pipe(
          Effect.scoped,
          Effect.provide(
            layer.pipe(Layer.provideMerge(boat.layer), Layer.provideMerge(machine.layer)),
          ),
        );
      },
    );

    it.live(
      "revokes the auth key and deletes the sandbox after a refused join without reporting the key",
      () => {
        const machine = fakeMachine();
        machine.state.tailscaleJoin = "refused";
        machine.state.localFiles.set("/keys/boat.pub", "ssh-ed25519 AAAATest");
        const boat = fakeProviders();
        const api = fakeTailnet();
        const gateway = fakeGateway(machine, providers);
        const layer = sshLayer({
          workers: [address],
          instance: INSTANCE,
          instanceId: INSTANCE_ID,
          boxdClient: boat.boxdClient,
          boxdExec: boat.boxdExecOn(machine),
          providerEndpoints: { boat: BOAT_TEST_API },
          machinePollInterval: "1 millis",
          machineReadyTimeout: "5 seconds",
        }).pipe(
          Layer.provide(harnessesLive),
          Layer.provide(machine.layer),
          Layer.provide(mintingProvider().layer),
          Layer.provide(stubAttemptRuntime(new StubStorage(), completes)),
          Layer.provide(hostLoginLockLayer),
          Layer.provide(boat.over(api.over(gateway.layer))),
        );
        return Effect.gen(function* () {
          const machines = yield* WorkerMachines;
          const failure = yield* machines
            .create(WORKER, MACHINE_RUN, AttemptId.make("remote-run/execute/1"), [TEST_AGENT.brain])
            .pipe(Effect.flip);
          assert.include(failure.message, "could not join");
          assert.strictEqual(failure.message.includes("provisioner.egress"), restricted);
          const json2 = jsonKey(failure);
          assert.notInclude(json2, "tskey-auth-test");
          assert.strictEqual(
            (provider === "boxd" ? boat.boxd.machines : boat.boat.sandboxes).size,
            0,
          );
          assert.isTrue(api.calls.some((call) => call.method === "DELETE"));
          assert.isFalse(
            gateway.calls.some((call) => call.method === "POST" && call.path === "/v1/attachments"),
          );
          assert.isTrue(
            machine.state.calls.some((call) => call.line.includes("'tailscale' 'logout'")),
          );
        }).pipe(Effect.scoped, Effect.provide(layer));
      },
    );

    for (const harness of ["claude", "codex"] as const) {
      it.live(
        `runs ${harness} in a ${provider} container on the gateway subscription, then detaches and logs out`,
        () => {
          const machine = fakeMachine();
          machine.state.docker = "running";
          machine.state.forwardProxyReachable = false;
          machine.state.localFiles.set("/keys/boat.pub", "ssh-ed25519 AAAATest");
          const boat = fakeProviders();
          const api = fakeTailnet();
          const gateway = fakeGateway(machine, providers);
          const agent = Agent.make({
            ...TEST_AGENT,
            brain: BrainSpec.make({
              harness: Harness.make(harness),
              model: ModelId.make(harness === "codex" ? "gpt-5.6-sol" : "claude-sonnet-4-6"),
              effort: "high",
            }),
          });
          const attempt = CheckoutRequest.make({ ...request, agent });
          let launched = false;
          const runtime = stubAttemptRuntime(new StubStorage(), (context) =>
            Effect.gen(function* () {
              launched = true;
              assert.strictEqual(machine.state.credentials.size, 0);
              for (const call of machine.state.calls) {
                assert.notInclude(call.line + call.input, TOKEN_PREFIX);
                assert.notInclude(call.line + call.input, "sk-ant-oat01-test");
                assert.notInclude(call.line + call.input, "test-client-secret");
              }
              if (provider === "boxd") assert(Schema.is(ExecShell)(context.request.host));
              else {
                assert(Schema.is(RemoteShell)(context.request.host));
                assert.notInclude(context.request.host.ssh.args, "-J");
              }
              assert.strictEqual(context.request.environment.HTTPS_PROXY, "");
              const currentGatewayCredential = yield* context.request.gatewayCredential;
              assert.deepStrictEqual(currentGatewayCredential, Option.some("subscription"));
              return yield* completes(context);
            }),
          );
          const layer = sshLayer({
            workers: [address],
            instance: INSTANCE,
            instanceId: INSTANCE_ID,
            boxdClient: boat.boxdClient,
            boxdExec: boat.boxdExecOn(machine),
            providerEndpoints: { boat: BOAT_TEST_API },
            machinePollInterval: "1 millis",
            machineReadyTimeout: "5 seconds",
          }).pipe(
            Layer.provide(harnessesLive),
            Layer.provide(machine.layer),
            Layer.provide(mintingProvider().layer),
            Layer.provide(runtime),
            Layer.provide(hostLoginLockLayer),
            Layer.provide(boat.over(api.over(gateway.layer))),
          );
          return Effect.gen(function* () {
            yield* Effect.gen(function* () {
              const executor = yield* Executor;
              const machines = yield* WorkerMachines;
              yield* executor.preflight(WORKER, [agent.brain], 1);
              const grant = yield* machines.create(WORKER, MACHINE_RUN, attempt.attemptId, [
                agent.brain,
              ]);

              yield* Effect.gen(function* () {
                yield* (yield* executor.prepare(attempt)).launch(sink);
              }).pipe(Effect.scoped);
              yield* machines.release(grant.hold);
            }).pipe(Effect.scoped, Effect.provide(layer));
            assert.isTrue(launched);
            assert.strictEqual(machine.state.credentials.size, 0);
            assert.strictEqual(
              (provider === "boxd" ? boat.boxd.machines : boat.boat.sandboxes).size,
              0,
            );
            const join = machine.state.calls.find((call) => call.line.includes("'tailscale' 'up'"));
            assert(join !== undefined);
            assert.strictEqual(join.input, "tskey-auth-test");
            assert.notInclude(join.line, "tskey-auth-test");
            assert.include(join.line, "--accept-dns=false");
            assert.include(join.line, "--accept-routes=false");
            const container = machine.state.calls.find(
              (call) =>
                call.line.startsWith("exec 'docker' 'run'") && call.line.includes("--add-host"),
            );
            assert(container !== undefined);
            assert.include(container.line, "git.gw.test:100.64.0.2");
            assert.include(container.line, "llm.gw.test:100.64.0.2");
            assert.isTrue(
              machine.state.calls.some((call) => call.line.includes("'tailscale' 'logout'")),
            );
            assert.isTrue(gateway.calls.some((call) => call.method === "DELETE"));
            assert.strictEqual(api.calls.filter((call) => call.method === "DELETE").length, 2);
          });
        },
      );
    }
  });
}
