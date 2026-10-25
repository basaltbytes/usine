import { assert, describe, it } from "@effect/vitest";
import { RemoteShell } from "@usine/agents/child-host";
import { Agent, AgentName, AgentPersona } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AttemptId } from "@usine/core/attempt";
import type { AttemptRecovery } from "@usine/core/attempt/salvage";
import { RunId } from "@usine/core/run";
import { SshIdentityFile, WorkerRoot } from "@usine/core/worker";
import type { AttemptRequest } from "@usine/durable/attempt-runtime";
import {
  completes,
  type StubParent,
  StubStorage,
  stubAttemptRuntime,
} from "@usine/durable/testing";
import { Deferred, Effect, Fiber, Layer, Option, Redacted } from "effect";
import {
  CheckoutRequest,
  claudeLoginLockLayer,
  Executor,
  WorkerMachines,
} from "../../../src/executor.ts";
import type { SshWorkerAddress } from "../../../src/ssh/model.ts";
import { attemptTag } from "../../../src/ssh/provisioner/model.ts";
import { layer as sshLayer } from "../../../src/ssh/ssh.ts";
import {
  ADDRESS,
  aloneOnItem,
  capturedLogs,
  fakeMachine,
  INSTANCE,
  LOCAL_TEMPORARY_DIRECTORY,
  mintingProvider,
  request,
  TEST_AGENT,
  WORKER,
} from "../support.ts";
import { boatSettings, hetznerSettings } from "./support.ts";
import { fakeGateway, gatewayAddress } from "../gateway/support.ts";
import { BOAT_TEST_API, fakeProviders, HETZNER_TEST_API } from "./fake-providers.ts";

const ROOT = WorkerRoot.make("/home/usine/.usine");
const RUN = RunId.make("remote-run");
const KEY = "sk-ant-api-for-provisioned-tests";

/** A provisioned Hetzner Worker without a Gateway, whose Attempts get an Anthropic API key. */
const hetznerAddress: SshWorkerAddress = {
  ...ADDRESS,
  port: Option.none(),
  root: ROOT,
  machine: {
    _tag: "Provisioned",
    provisioner: hetznerSettings({
      network: Option.none(),
      apiKeys: { anthropic: Option.some(Redacted.make(KEY)) },
    }),
  },
};

const boatAddress: SshWorkerAddress = {
  ...ADDRESS,
  port: Option.none(),
  root: WorkerRoot.make("/home/user/.usine"),
  identityFile: Option.some(SshIdentityFile.make("/keys/usine_boat")),
  machine: { _tag: "Provisioned", provisioner: boatSettings() },
};

const sink = {
  append: () => Effect.void,
  salvage: () => Effect.void,
  comments: () => Effect.void,
  transcript: Effect.succeed([]),
  windows: aloneOnItem(),
};

const runtimeOf = (
  machine: ReturnType<typeof fakeMachine>,
  providers: ReturnType<typeof fakeProviders>,
  address: SshWorkerAddress,
  options: { readonly parent?: StubParent; readonly storage?: StubStorage } = {},
) =>
  sshLayer({
    workers: [address],
    instance: INSTANCE,
    interruptGrace: "2 seconds",
    providerEndpoints: { hetzner: HETZNER_TEST_API, boat: BOAT_TEST_API },
    machinePollInterval: "1 millis",
    machineReadyTimeout: "1 second",
  }).pipe(
    Layer.provide(machine.layer),
    Layer.provide(mintingProvider().layer),
    Layer.provide(
      stubAttemptRuntime(options.storage ?? new StubStorage(), options.parent ?? completes),
    ),
    Layer.provide(claudeLoginLockLayer),
    Layer.provide(providers.layer),
  );

const codexAgent = new Agent({
  name: AgentName.make("reviewer"),
  brain: new BrainSpec({ harness: "codex", model: ModelId.make("gpt-5.6-sol"), effort: "high" }),
  parentModel: Option.none(),
  parentEffort: Option.none(),
  persona: AgentPersona.make("Review the change."),
});

describe("Provisioned SSH Worker behind a Gateway", () => {
  it.live(
    "creates the server on the Gateway's network without public addresses, jumps through the Gateway, and attaches the token there",
    () => {
      const machine = fakeMachine();
      const providers = fakeProviders();
      const gateway = fakeGateway(machine);
      const address: SshWorkerAddress = {
        ...gatewayAddress(),
        port: Option.none(),
        root: ROOT,
        machine: { _tag: "Provisioned", provisioner: hetznerSettings() },
      };
      let given: AttemptRequest | undefined;
      const parent: StubParent = (context) => {
        given = context.request;
        return completes(context);
      };
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const machines = yield* WorkerMachines;
        const report = yield* executor.preflight(WORKER, [TEST_AGENT.brain], 2);
        assert.isTrue(Option.isSome(report.deferred));
        const grant = yield* machines.create(WORKER, RUN, [TEST_AGENT.brain]);
        const created = providers.calls.find(
          ({ method, path }) => method === "POST" && path === "/servers",
        );
        assert.deepInclude(created?.body ?? {}, {
          networks: [7],
          public_net: { enable_ipv4: false, enable_ipv6: false },
        });
        yield* machines.assign(grant.hold, request.attemptId);
        const prepared = yield* executor.prepare(request);
        yield* prepared.launch(sink);
        assert(given !== undefined && given.host instanceof RemoteShell);
        assert.strictEqual(given.host.destination, "usine@10.42.0.5");
        const jump = given.host.ssh.args.indexOf("-J");
        assert.strictEqual(given.host.ssh.args[jump + 1], "usine-gateway");
        assert.isTrue(
          gateway.calls.some(({ method, path }) => method === "POST" && path === "/v1/attachments"),
          "the Attempt's token was attached to the Gateway",
        );
        yield* machines.release(grant.hold);
        assert.strictEqual(providers.hetzner.servers.size, 0);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          sshLayer({
            workers: [address],
            instance: INSTANCE,
            interruptGrace: "2 seconds",
            providerEndpoints: { hetzner: HETZNER_TEST_API },
            machinePollInterval: "1 millis",
            machineReadyTimeout: "1 second",
          }).pipe(
            Layer.provide(machine.layer),
            Layer.provide(mintingProvider().layer),
            Layer.provide(stubAttemptRuntime(new StubStorage(), parent)),
            Layer.provide(claudeLoginLockLayer),
            Layer.provide(providers.over(gateway.layer)),
          ),
        ),
      );
    },
  );
});

describe("Provisioned SSH Worker", () => {
  it.live(
    "creates a machine for the Run, runs the Attempt on it with the API key, and deletes it on release",
    () => {
      const machine = fakeMachine();
      const providers = fakeProviders();
      const logs = capturedLogs();
      let given: AttemptRequest | undefined;
      const parent: StubParent = (context) => {
        given = context.request;
        return completes(context);
      };
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const machines = yield* WorkerMachines;
        assert.isTrue(yield* machines.provisions(WORKER));

        const grant = yield* machines.create(WORKER, RUN, [TEST_AGENT.brain]);
        const [server] = providers.hetzner.servers.values();
        assert(server !== undefined, "a server exists");
        assert.strictEqual(String(server.id), grant.id);
        assert.strictEqual(server.labels["usine-run"], RUN);
        assert.strictEqual(server.labels["usine-instance"], INSTANCE);
        assert.isUndefined(server.labels["usine-attempt"]);
        // The first machine of the day gets the machine preflight with the roster.
        assert.deepStrictEqual(grant.checked, Option.some([TEST_AGENT.brain]));
        const statuses = yield* machines.machines;
        assert.deepStrictEqual(
          statuses.map(({ state, id }) => [state, Option.getOrNull(id)]),
          [["ready", grant.id]],
        );

        yield* machines.assign(grant.hold, request.attemptId);
        assert.strictEqual(server.labels["usine-attempt"], attemptTag(request.attemptId));
        const prepared = yield* executor.prepare(request);
        assert.strictEqual(
          prepared.workspace.worktree,
          `${ROOT}/workers/eu-one/attempts/remote-run_execute_1`,
        );
        yield* prepared.launch(sink);
        assert(given !== undefined && given.host instanceof RemoteShell);
        const destination = `usine@${server.publicIp ?? ""}`;
        assert.strictEqual(given.host.destination, destination);
        assert.include(given.host.ssh.args, "StrictHostKeyChecking=accept-new");
        assert.include(
          given.host.ssh.args,
          `UserKnownHostsFile=${LOCAL_TEMPORARY_DIRECTORY}/hetzner-${grant.id}`,
        );
        // Without Docker, the key goes over the SSH connection, never in a command line.
        assert.strictEqual(given.host.sshEnvironment.ANTHROPIC_API_KEY, KEY);
        assert.isFalse(machine.state.calls.some(({ line }) => line.includes(KEY)));
        assert.isTrue(
          machine.state.calls.every(({ command }) => command.args.includes(destination)),
          "every command ran on the new machine",
        );

        yield* machines.release(grant.hold);
        assert.strictEqual(providers.hetzner.servers.size, 0);
        assert.lengthOf(yield* machines.machines, 0);
        assert.include(logs.lines.join("\n"), "Deleted the machine");
      }).pipe(
        Effect.scoped,
        Effect.provide(runtimeOf(machine, providers, hetznerAddress, { parent })),
        Effect.provide(logs.layer),
      );
    },
  );

  it.live("gives the API key to the Attempt's container on docker run's standard input", () => {
    const machine = fakeMachine();
    machine.state.docker = "running";
    const providers = fakeProviders();
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const machines = yield* WorkerMachines;
      const grant = yield* machines.create(WORKER, RUN, [TEST_AGENT.brain]);
      yield* machines.assign(grant.hold, request.attemptId);
      const prepared = yield* executor.prepare(request);
      yield* prepared.launch(sink);
      const run = machine.state.calls.find(
        ({ line }) =>
          line.startsWith("exec 'docker' 'run' ") && line.includes("'usine-remote-run_execute_1'"),
      );
      assert(run !== undefined, "the Attempt ran in a container");
      assert.include(run.input, `ANTHROPIC_API_KEY=${KEY}`);
      assert.notInclude(run.line, KEY);
    }).pipe(Effect.scoped, Effect.provide(runtimeOf(machine, providers, hetznerAddress)));
  });

  it.live(
    "keeps the machine of a checkout that a stopping process kept, and reattaches on it after the restart",
    () => {
      const machine = fakeMachine();
      const providers = fakeProviders();
      const storage = new StubStorage();
      return Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const working: StubParent = () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          const machines = yield* WorkerMachines;
          const grant = yield* machines.create(WORKER, RUN, [TEST_AGENT.brain]);
          yield* machines.assign(grant.hold, request.attemptId);
          const launch = yield* (yield* executor.prepare(request))
            .launch(sink)
            .pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* Fiber.interrupt(launch);
          // The engine releases the slot as the process stops.
          yield* machines.release(grant.hold);
          assert.strictEqual(providers.hetzner.servers.size, 1, "the machine keeps the checkout");
          yield* machines.sweep;
          assert.strictEqual(providers.hetzner.servers.size, 1);
        }).pipe(
          Effect.scoped,
          Effect.provide(
            runtimeOf(machine, providers, hetznerAddress, { parent: working, storage }),
          ),
        );

        let given: AttemptRequest | undefined;
        const parent: StubParent = (context) => {
          given = context.request;
          return completes(context);
        };
        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          const machines = yield* WorkerMachines;
          assert.isTrue(yield* executor.isLive(request.attemptId));
          const hold = yield* machines.adopt(WORKER, request.attemptId);
          assert.isTrue(Option.isSome(hold));
          const prepared = yield* executor.prepare(
            new CheckoutRequest({ ...request, reattach: true }),
          );
          yield* prepared.launch(sink);
          const [server] = providers.hetzner.servers.values();
          assert(server !== undefined && given !== undefined && given.host instanceof RemoteShell);
          assert.strictEqual(given.host.destination, `usine@${server.publicIp ?? ""}`);
          if (Option.isSome(hold)) yield* machines.release(hold.value);
          assert.strictEqual(providers.hetzner.servers.size, 0);
        }).pipe(
          Effect.scoped,
          Effect.provide(runtimeOf(machine, providers, hetznerAddress, { parent, storage })),
        );
      });
    },
  );

  it.live("checks only the first machine of the day", () => {
    const machine = fakeMachine();
    const providers = fakeProviders();
    return Effect.gen(function* () {
      const machines = yield* WorkerMachines;
      const first = yield* machines.create(WORKER, RUN, [TEST_AGENT.brain]);
      const memoryChecks = () =>
        machine.state.calls.filter(({ line }) => line === "exec 'cat' '/proc/meminfo'").length;
      assert.strictEqual(memoryChecks(), 1);
      const second = yield* machines.create(WORKER, RunId.make("other-run"), [TEST_AGENT.brain]);
      assert.isTrue(Option.isSome(first.checked));
      assert.isTrue(Option.isNone(second.checked));
      assert.strictEqual(memoryChecks(), 1);
      assert.strictEqual(providers.hetzner.servers.size, 2);
    }).pipe(Effect.scoped, Effect.provide(runtimeOf(machine, providers, hetznerAddress)));
  });

  it.live(
    "fails a creation that the provider refuses or whose machine never answers, and leaves no machine",
    () => {
      const machine = fakeMachine();
      const providers = fakeProviders();
      return Effect.gen(function* () {
        const machines = yield* WorkerMachines;
        providers.hetzner.createFails = {
          status: 403,
          code: "resource_limit_exceeded",
          message: "project limit exceeded",
        };
        const quota = yield* machines.create(WORKER, RUN, [TEST_AGENT.brain]).pipe(Effect.flip);
        assert(quota._tag === "MachineUnavailableError");
        assert.strictEqual(quota.reason, "quota");
        assert.lengthOf(yield* machines.machines, 0);

        providers.hetzner.createFails = undefined;
        machine.state.reachable = false;
        const silent = yield* machines.create(WORKER, RUN, [TEST_AGENT.brain]).pipe(Effect.flip);
        assert(silent._tag === "MachineUnavailableError");
        assert.strictEqual(silent.reason, "timeout");
        assert.strictEqual(providers.hetzner.servers.size, 0, "the silent machine was deleted");
        assert.lengthOf(yield* machines.machines, 0);

        machine.state.reachable = true;
        machine.state.memoryGib = 1;
        const unchecked = yield* machines.create(WORKER, RUN, [TEST_AGENT.brain]).pipe(Effect.flip);
        assert(unchecked._tag === "WorkerCapabilityError");
        assert.strictEqual(unchecked.capability, "memory");
        assert.strictEqual(providers.hetzner.servers.size, 0);
      }).pipe(Effect.scoped, Effect.provide(runtimeOf(machine, providers, hetznerAddress)));
    },
  );

  it.live(
    "sweeps the machines of earlier processes that no Attempt holds, and keeps the ones it holds",
    () => {
      const machine = fakeMachine();
      const providers = fakeProviders();
      const now = new Date().toISOString();
      const earlier = (id: number, attempt: string | undefined) => {
        const labels = new Map<string, string>([
          ["usine-instance", INSTANCE],
          ["usine-worker", WORKER],
          ["usine-run", "earlier-run"],
          ["usine-process", "earlier00000"],
        ]);
        if (attempt !== undefined) labels.set("usine-attempt", attempt);
        providers.hetzner.servers.set(id, {
          id,
          name: `usine-eu-one-${String(id)}`,
          status: "running",
          created: now,
          labels: Object.fromEntries(labels),
          privateIp: undefined,
          publicIp: "203.0.113.90",
          startingReads: 0,
        });
      };
      return Effect.gen(function* () {
        const machines = yield* WorkerMachines;
        earlier(11, attemptTag(request.attemptId));
        earlier(12, "hdeadbeefdeadbeef");
        earlier(13, undefined);
        providers.hetzner.servers.set(14, {
          ...providers.hetzner.servers.get(13)!,
          id: 14,
          labels: {
            ...providers.hetzner.servers.get(13)!.labels,
            "usine-instance": "github-app-1",
          },
        });
        // Startup recovery occupies the slot of the Attempt that still runs on server 11.
        const adopted = yield* machines.adopt(WORKER, request.attemptId);
        assert.isTrue(Option.isSome(adopted));
        const ours = yield* machines.create(WORKER, RUN, [TEST_AGENT.brain]);
        yield* machines.sweep;
        assert.deepStrictEqual(
          [...providers.hetzner.servers.keys()].sort(),
          [11, 14, Number(ours.id)].sort(),
          "the orphans of this instance are deleted, the held ones and another instance's stay",
        );
        if (Option.isSome(adopted)) yield* machines.release(adopted.value);
        assert.isFalse(providers.hetzner.servers.has(11));
      }).pipe(Effect.scoped, Effect.provide(runtimeOf(machine, providers, hetznerAddress)));
    },
  );

  it.live(
    "keeps a machine whose sweep can't delete it until a later sweep can, and a held machine whose slot isn't released",
    () => {
      const machine = fakeMachine();
      const providers = fakeProviders();
      return Effect.gen(function* () {
        const machines = yield* WorkerMachines;
        const grant = yield* machines.create(WORKER, RUN, [TEST_AGENT.brain]);
        yield* machines.assign(grant.hold, request.attemptId);
        // A kept checkout's slot isn't released, so a sweep leaves its machine.
        yield* machines.sweep;
        assert.strictEqual(providers.hetzner.servers.size, 1);

        providers.hetzner.deleteFails = { status: 500, code: "server_error", message: "down" };
        yield* machines.release(grant.hold);
        assert.strictEqual(providers.hetzner.servers.size, 1);
        assert.deepStrictEqual(
          (yield* machines.machines).map(({ state }) => state),
          ["deleting"],
        );
        providers.hetzner.deleteFails = undefined;
        yield* machines.sweep;
        assert.strictEqual(providers.hetzner.servers.size, 0);
        assert.lengthOf(yield* machines.machines, 0);
      }).pipe(Effect.scoped, Effect.provide(runtimeOf(machine, providers, hetznerAddress)));
    },
  );

  it.live("recovers an earlier process's Attempt on its machine, then deletes the machine", () => {
    const machine = fakeMachine();
    machine.state.cacheExists = true;
    const providers = fakeProviders();
    return Effect.gen(function* () {
      const executor = yield* Executor;
      providers.hetzner.servers.set(21, {
        id: 21,
        name: "usine-eu-one-21",
        status: "running",
        created: new Date().toISOString(),
        labels: {
          "usine-instance": INSTANCE,
          "usine-worker": WORKER,
          "usine-run": RUN,
          "usine-process": "earlier00000",
          "usine-attempt": attemptTag(request.attemptId),
        },
        privateIp: undefined,
        publicIp: "203.0.113.91",
        startingReads: 0,
      });
      const attempt: AttemptRecovery = {
        attemptId: request.attemptId,
        worker: WORKER,
        repository: request.repository,
        ref: request.salvageRef,
        permissions: "write",
        succeeded: true,
        open: false,
      };
      yield* executor.recover(attempt, sink, Effect.succeed(request.commitAuthor));
      assert.isTrue(
        machine.state.calls.some(({ command }) => command.args.includes("usine@203.0.113.91")),
        "the recovery ran on the Attempt's machine",
      );
      assert.strictEqual(providers.hetzner.servers.size, 0, "the machine is deleted after");
      // An Attempt whose machine is gone has nothing to reconcile.
      yield* executor.recover(
        {
          ...attempt,
          attemptId: AttemptId.make("remote-run/execute/2"),
        },
        sink,
        Effect.succeed(request.commitAuthor),
      );
    }).pipe(Effect.scoped, Effect.provide(runtimeOf(machine, providers, hetznerAddress)));
  });

  it.live(
    "preflights without a machine: the provider, then the harness credentials, and defers the harness checks",
    () => {
      const machine = fakeMachine();
      const providers = fakeProviders();
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const report = yield* executor.preflight(WORKER, [TEST_AGENT.brain], 4);
        assert.isTrue(Option.isNone(report.degraded));
        assert.isTrue(Option.isSome(report.deferred));
        assert.lengthOf(machine.state.calls, 0, "no machine was contacted");
        assert.strictEqual(providers.hetzner.servers.size, 0, "no machine was created");

        const codex = yield* executor.preflight(WORKER, [codexAgent.brain], 1).pipe(Effect.flip);
        assert(codex._tag === "WorkerCapabilityError");
        assert.strictEqual(codex.capability, "harness-login");
        assert.include(codex.message, "Codex children don't run on API keys");

        providers.hetzner.token = "rotated";
        const token = yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1).pipe(Effect.flip);
        assert(token._tag === "WorkerCapabilityError");
        assert.strictEqual(token.capability, "provider");
      }).pipe(Effect.scoped, Effect.provide(runtimeOf(machine, providers, hetznerAddress)));
    },
  );

  it.live(
    "refuses Claude Code on a provisioned Worker with neither a Gateway credential nor an API key",
    () => {
      const machine = fakeMachine();
      const providers = fakeProviders();
      const keyless: SshWorkerAddress = {
        ...hetznerAddress,
        machine: {
          _tag: "Provisioned",
          provisioner: hetznerSettings({ network: Option.none() }),
        },
      };
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const refused = yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1).pipe(Effect.flip);
        assert(refused._tag === "WorkerCapabilityError");
        assert.strictEqual(refused.capability, "harness-login");
        assert.include(refused.message, "provisioner.api_keys.anthropic");
        assert.include(refused.message, "A subscription login needs a gateway");
      }).pipe(Effect.scoped, Effect.provide(runtimeOf(machine, providers, keyless)));
    },
  );

  it.live(
    "creates a Boat sandbox, pins its host key, and refuses a Boat Worker without the identity file's public key",
    () => {
      const machine = fakeMachine();
      machine.state.localFiles.set("/keys/usine_boat.pub", "ssh-ed25519 AAAAOperatorKey usine\n");
      const providers = fakeProviders();
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const machines = yield* WorkerMachines;
        yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
        const grant = yield* machines.create(WORKER, RUN, [TEST_AGENT.brain]);
        const known = machine.state.localFiles.get(`${LOCAL_TEMPORARY_DIRECTORY}/boat-${grant.id}`);
        assert.strictEqual(known, `198.51.100.20 ${providers.boat.hostKey}\n`);
        const key = providers.calls.find(({ path }) => path.endsWith("/sshkey"));
        assert.deepStrictEqual(key?.body, { key: "ssh-ed25519 AAAAOperatorKey usine" });
        assert.isTrue(
          machine.state.calls.some(({ command }) =>
            command.args.includes("StrictHostKeyChecking=yes"),
          ),
        );
        yield* machines.release(grant.hold);
        assert.strictEqual(providers.boat.sandboxes.size, 0);
        assert.isUndefined(
          machine.state.localFiles.get(`${LOCAL_TEMPORARY_DIRECTORY}/boat-${grant.id}`),
        );
      }).pipe(Effect.scoped, Effect.provide(runtimeOf(machine, providers, boatAddress)));
    },
  );

  it.live("refuses a Boat Worker whose identity file has no public key", () => {
    const machine = fakeMachine();
    const providers = fakeProviders();
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const refused = yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1).pipe(Effect.flip);
      assert(refused._tag === "WorkerCapabilityError");
      assert.include(refused.message, "/keys/usine_boat.pub");
    }).pipe(Effect.scoped, Effect.provide(runtimeOf(machine, providers, boatAddress)));
  });
});
