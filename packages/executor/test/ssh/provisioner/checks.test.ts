import { assert, it } from "@effect/vitest";
import { RemoteShell } from "@usine/agents/child-host";
import { completes, type StubParent } from "@usine/durable/testing";
import {
  ContainerCpus,
  ContainerImage,
  ContainerMemoryMib,
  ContainerPids,
  ProvisionerSeconds,
  ProvisionerTimings,
} from "@usine/core/worker";
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

for (const replacementDocker of ["absent", "running"] as const) {
  it.live(
    `keeps an allocated machine's isolation after replacement preflight with Docker ${replacementDocker}`,
    () => {
      const machine = fakeMachine();
      machine.state.docker = "running";
      const providers = fakeProviders();
      const destinations: string[] = [];
      const originalImage = ContainerImage.make("ghcr.io/example/attempt:original");
      const replacementImage = ContainerImage.make("ghcr.io/example/attempt:replacement");
      const originalAddress = {
        ...hetznerAddress,
        container: { ...hetznerAddress.container, image: Option.some(originalImage) },
      };
      const replacementAddress = {
        ...ADDRESS,
        container: {
          image: Option.some(replacementImage),
          cpus: Option.some(ContainerCpus.make(1)),
          memoryMib: Option.some(ContainerMemoryMib.make(2048)),
          pids: Option.some(ContainerPids.make(1024)),
        },
      };
      const parent: StubParent = (context) => {
        assert(context.request.host instanceof RemoteShell);
        destinations.push(context.request.host.destination);
        if (context.request.host.destination !== DESTINATION || replacementDocker === "running") {
          assert.isDefined(context.request.host.container, "the attempt runs in its container");
        } else {
          assert.isUndefined(context.request.host.container);
        }
        return completes(context);
      };
      return Effect.gen(function* () {
        const machines = yield* WorkerMachines;
        const workers = yield* SshWorkers;
        const executor = yield* Executor;
        const original = yield* machines.create(WORKER, RUN, request.attemptId, [TEST_AGENT.brain]);
        const [server] = providers.hetzner.servers.values();
        assert(server?.publicIp !== undefined);
        yield* workers.addWorker(replacementAddress);
        machine.state.docker = replacementDocker;
        yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
        machine.state.docker = "running";
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* (yield* executor.prepare(request)).launch(sink);
          }),
        );
        assert.deepStrictEqual(destinations, [`usine@${server.publicIp}`]);
        const originalRun = machine.state.calls.find(({ line }) =>
          line.startsWith("exec 'docker' 'run' '--detach' '--name' 'usine-remote-run_execute_1'"),
        );
        assert.include(originalRun?.line, `'${originalImage}'`);
        assert.include(
          originalRun?.line,
          "'--cpus' '2' '--memory' '4096m' '--memory-swap' '4096m' '--pids-limit' '4096'",
        );
        yield* machines.release(original.hold);
        assert.strictEqual(providers.hetzner.servers.size, 0);

        const next = new CheckoutRequest({
          ...request,
          attemptId: AttemptId.make("fixed-attempt"),
        });
        machine.state.docker = replacementDocker;
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* (yield* executor.prepare(next)).launch(sink);
          }),
        );
        assert.deepStrictEqual(destinations, [`usine@${server.publicIp}`, DESTINATION]);
        const replacementRun = machine.state.calls.find(({ line }) =>
          line.startsWith("exec 'docker' 'run' '--detach' '--name' 'usine-fixed-attempt'"),
        );
        if (replacementDocker === "running") {
          assert.include(replacementRun?.line, `'${replacementImage}'`);
          assert.include(
            replacementRun?.line,
            "'--cpus' '1' '--memory' '2048m' '--memory-swap' '2048m' '--pids-limit' '1024'",
          );
        } else {
          assert.isUndefined(replacementRun);
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(runtimeOf(machine, providers, originalAddress, { parent })),
      );
    },
  );
}
