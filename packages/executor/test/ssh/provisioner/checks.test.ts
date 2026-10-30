import { assert, it } from "@effect/vitest";
import { RemoteShell } from "@usine/agents/child-host";
import { completes, type StubParent } from "@usine/durable/testing";
import { ContainerImage, ProvisionerSeconds, ProvisionerTimings } from "@usine/core/worker";
import { Effect, Fiber, Option } from "effect";
import { AttemptId } from "@usine/core/attempt";
import { SshWorkers } from "../../../src/ssh/ssh.ts";
import { CheckoutRequest, Executor, WorkerMachines } from "../../../src/executor.ts";
import { ADDRESS, DESTINATION, fakeMachine, request, TEST_AGENT, WORKER } from "../support.ts";
import { boatAddress, hetznerAddress, RUN, runtimeOf, sink } from "./fixtures.ts";
import { fakeProviders } from "./fake-providers.ts";
import { hetznerSettings } from "./support.ts";

it.live("uses the configured SSH wait and deletes the unreachable machine on timeout", () => {
  const machine = fakeMachine();
  machine.state.reachable = false;
  const providers = fakeProviders();
  providers.hetzner.startingReads = 0;
  const address = {
    ...hetznerAddress,
    machine: {
      _tag: "Provisioned" as const,
      provisioner: hetznerSettings({
        timings: new ProvisionerTimings({ sshWait: ProvisionerSeconds.make(2) }),
      }),
    },
  };
  return Effect.gen(function* () {
    const machines = yield* WorkerMachines;
    const creating = yield* Effect.forkChild(
      machines.create(WORKER, RUN, request.attemptId, [TEST_AGENT.brain]).pipe(Effect.flip),
    );
    yield* Effect.sleep("1 second");
    assert.isUndefined(creating.pollUnsafe());
    const failure = yield* Fiber.join(creating);
    assert.strictEqual(failure._tag, "MachineUnavailableError");
    assert.include(failure.message, "2s");
    assert.strictEqual(providers.hetzner.servers.size, 0);
  }).pipe(Effect.scoped, Effect.provide(runtimeOf(machine, providers, address)));
});

it.live("reports the Boat SSH user's UID and image to rebuild on the first machine check", () => {
  const machine = fakeMachine();
  machine.state.localFiles.set("/keys/usine_boat.pub", "ssh-ed25519 AAAATest");
  machine.state.docker = "running";
  machine.state.hostUserId = "2345";
  const providers = fakeProviders();
  const image = ContainerImage.make("ghcr.io/example/attempt:boat");
  const address = {
    ...boatAddress,
    container: { ...boatAddress.container, image: Option.some(image) },
  };
  return Effect.gen(function* () {
    const machines = yield* WorkerMachines;
    const failure = yield* machines
      .create(WORKER, RUN, request.attemptId, [TEST_AGENT.brain])
      .pipe(Effect.flip);
    assert.strictEqual(failure._tag, "WorkerCapabilityError");
    assert.include(failure.message, image);
    assert.include(failure.message, "--build-arg USINE_UID=2345");
    assert.strictEqual(providers.boat.sandboxes.size, 0);
    machine.state.imageUserId = "2345";
    const fixed = yield* machines.create(WORKER, RUN, request.attemptId, [TEST_AGENT.brain]);
    assert.isTrue(Option.isSome(fixed.checked), "a failed check does not defer the next check");
    yield* machines.release(fixed.hold);
  }).pipe(Effect.scoped, Effect.provide(runtimeOf(machine, providers, address)));
});

it.live(
  "uses a changed provisioner for new machines and deletes the existing machine through its original provider",
  () => {
    const machine = fakeMachine();
    machine.state.localFiles.set("/keys/usine_boat.pub", "ssh-ed25519 AAAATest");
    const providers = fakeProviders();
    return Effect.gen(function* () {
      const machines = yield* WorkerMachines;
      const workers = yield* SshWorkers;
      const executor = yield* Executor;
      const original = yield* machines.create(WORKER, RUN, request.attemptId, [TEST_AGENT.brain]);
      yield* workers.addWorker(boatAddress);
      yield* executor.preflight(WORKER, [], 1);
      const next = yield* machines.create(WORKER, RUN, AttemptId.make("replacement-attempt"), []);
      assert.strictEqual(next.provider, "boat");
      assert.strictEqual(providers.hetzner.servers.size, 1);
      assert.strictEqual(providers.boat.sandboxes.size, 1);
      yield* machines.release(original.hold);
      assert.strictEqual(providers.hetzner.servers.size, 0);
      assert.strictEqual(providers.boat.sandboxes.size, 1);
      yield* machines.release(next.hold);
      assert.strictEqual(providers.boat.sandboxes.size, 0);
    }).pipe(Effect.scoped, Effect.provide(runtimeOf(machine, providers, hetznerAddress)));
  },
);

it.live("keeps an allocated machine when its worker becomes fixed before preparation", () => {
  const machine = fakeMachine();
  const providers = fakeProviders();
  const destinations: string[] = [];
  const parent: StubParent = (context) => {
    assert(context.request.host instanceof RemoteShell);
    destinations.push(context.request.host.destination);
    return completes(context);
  };
  return Effect.gen(function* () {
    const machines = yield* WorkerMachines;
    const workers = yield* SshWorkers;
    const executor = yield* Executor;
    const original = yield* machines.create(WORKER, RUN, request.attemptId, [TEST_AGENT.brain]);
    const [server] = providers.hetzner.servers.values();
    assert(server?.publicIp !== undefined);
    yield* workers.addWorker(ADDRESS);
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* (yield* executor.prepare(request)).launch(sink);
      }),
    );
    assert.deepStrictEqual(destinations, [`usine@${server.publicIp}`]);
    yield* machines.release(original.hold);
    assert.strictEqual(providers.hetzner.servers.size, 0);

    const next = new CheckoutRequest({ ...request, attemptId: AttemptId.make("fixed-attempt") });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* (yield* executor.prepare(next)).launch(sink);
      }),
    );
    assert.deepStrictEqual(destinations, [`usine@${server.publicIp}`, DESTINATION]);
  }).pipe(Effect.scoped, Effect.provide(runtimeOf(machine, providers, hetznerAddress, { parent })));
});
