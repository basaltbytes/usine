import { ChangeBus, changeBusLayer } from "@usine/core/changes";
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
import { Deferred, Effect, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";
import { AttemptId } from "@usine/core/attempt";
import { SshWorkers } from "../../../src/ssh/ssh.ts";
import { CheckoutRequest, Executor, WorkerMachines } from "../../../src/executor.ts";
import {
  ADDRESS,
  capturedLogs,
  DESTINATION,
  fakeMachine,
  request,
  TEST_AGENT,
  WORKER,
} from "../support.ts";
import { MACHINE_RUN, boatAddress, hetznerAddress, runtimeOf, sink } from "./fixtures.ts";
import { fakeProviders } from "./fake-providers.ts";
import { hetznerSettings } from "./support.ts";

const imagePullAddress = {
  ...hetznerAddress,
  machine: {
    _tag: "Provisioned" as const,
    provisioner: hetznerSettings({ network: Option.none() }),
  },
};

it.effect("keeps the same machine when a missing image pull succeeds on retry", () => {
  const machine = fakeMachine();
  machine.state.docker = "running";
  machine.state.imageOnMachine = false;
  const providers = fakeProviders();
  providers.hetzner.startingReads = 0;
  const logs = capturedLogs();
  const stderr = "Error response from daemon: Get https://ghcr.io/v2/: timeout";
  let pulls = 0;
  return Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    machine.state.beforePull = Effect.sync(() => {
      machine.state.pullError = pulls++ === 0 ? stderr : undefined;
    }).pipe(Effect.andThen(Deferred.succeed(started, undefined)));
    const bus = yield* ChangeBus;
    const machines = yield* WorkerMachines;
    const creating = yield* machines
      .create(WORKER, MACHINE_RUN, request.attemptId, [])
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    while (
      creating.pollUnsafe() === undefined &&
      !logs.lines.some((line) => line.includes("Retrying the attempt image pull"))
    )
      yield* Effect.yieldNow;
    const [id] = providers.hetzner.servers.keys();
    assert.strictEqual((yield* machines.machines)[0]?.state, "preparing");
    assert.deepStrictEqual(
      (yield* bus.open).history.at(-1)?.changes.filter(({ target }) => target.kind === "run"),
      [
        {
          audience: { _tag: "Loop", loop: MACHINE_RUN.loop },
          target: { kind: "run", id: MACHINE_RUN.id },
        },
      ],
    );
    const preparingRevision = (yield* bus.open).revision;
    yield* TestClock.adjust("4 seconds");
    assert.strictEqual(pulls, 1);
    assert.strictEqual((yield* bus.open).revision, preparingRevision);
    assert.deepStrictEqual([...providers.hetzner.servers.keys()], [id]);
    yield* TestClock.adjust("1 second");
    const grant = yield* Fiber.join(creating);
    assert.strictEqual(pulls, 2);
    assert.deepStrictEqual([...providers.hetzner.servers.keys()], [id]);
    assert.strictEqual((yield* machines.machines)[0]?.state, "ready");
    assert.isTrue(Option.isSome(grant.checked));
    const warnings = logs.warnings.filter((line) => line.includes("Attempt image pull failed"));
    assert.lengthOf(warnings, 1);
    assert.deepInclude(JSON.parse(warnings[0] ?? "")[1], { attempt: 1, stderr });
    const pulled = logs.lines.find((line) => line.includes("Pulled the attempt image"));
    assert.deepInclude(JSON.parse(pulled ?? "")[1], { attempt: 2, downloaded: true });
    yield* machines.release(grant.hold);
  }).pipe(
    Effect.scoped,
    Effect.provide(runtimeOf(machine, providers, imagePullAddress)),
    Effect.provide(changeBusLayer),
    Effect.provide(logs.layer),
  );
});

it.effect("fails preflight after three image pulls and logs the bounded last stderr", () => {
  const machine = fakeMachine();
  machine.state.docker = "running";
  machine.state.imageOnMachine = false;
  const providers = fakeProviders();
  providers.hetzner.startingReads = 0;
  const logs = capturedLogs();
  const errors = ["registry unavailable", "connection reset", `no space left: ${"x".repeat(1200)}`];
  let pulls = 0;
  return Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    machine.state.beforePull = Effect.sync(() => {
      machine.state.pullError = errors[pulls++];
    }).pipe(Effect.andThen(Deferred.succeed(started, undefined)));
    const machines = yield* WorkerMachines;
    const creating = yield* machines
      .create(WORKER, MACHINE_RUN, request.attemptId, [])
      .pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(started);
    while (
      creating.pollUnsafe() === undefined &&
      !logs.lines.some((line) => line.includes("Retrying the attempt image pull"))
    )
      yield* Effect.yieldNow;
    yield* TestClock.adjust("5 seconds");
    while (
      creating.pollUnsafe() === undefined &&
      logs.lines.filter((line) => line.includes("Retrying the attempt image pull")).length < 2
    )
      yield* Effect.yieldNow;
    yield* TestClock.adjust("14 seconds");
    assert.strictEqual(pulls, 2);
    assert.strictEqual(providers.hetzner.servers.size, 1);
    yield* TestClock.adjust("1 second");
    const failure = yield* Fiber.join(creating);
    assert(failure._tag === "WorkerCapabilityError");
    assert.strictEqual(failure.capability, "container");
    assert(failure.cause instanceof Error);
    assert.strictEqual(failure.cause.message, errors[2]);
    assert.strictEqual(pulls, 3);
    assert.strictEqual(providers.hetzner.servers.size, 0);
    const warnings = logs.warnings.filter((line) => line.includes("Attempt image pull failed"));
    assert.lengthOf(warnings, 3);
    assert.deepStrictEqual(
      warnings.map((line) => JSON.parse(line)[1].stderr),
      errors.map((stderr) => stderr.slice(0, 1000)),
    );
    assert.deepStrictEqual(
      warnings.map((line) => JSON.parse(line)[1].attempt),
      [1, 2, 3],
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(runtimeOf(machine, providers, imagePullAddress)),
    Effect.provide(logs.layer),
  );
});

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
      machines.create(WORKER, MACHINE_RUN, request.attemptId, [TEST_AGENT.brain]).pipe(Effect.flip),
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
      .create(WORKER, MACHINE_RUN, request.attemptId, [TEST_AGENT.brain])
      .pipe(Effect.flip);
    assert.strictEqual(failure._tag, "WorkerCapabilityError");
    assert.include(failure.message, image);
    assert.include(failure.message, "--build-arg USINE_UID=2345");
    assert.strictEqual(providers.boat.sandboxes.size, 0);
    machine.state.imageUserId = "2345";
    const fixed = yield* machines.create(WORKER, MACHINE_RUN, request.attemptId, [
      TEST_AGENT.brain,
    ]);
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
      const original = yield* machines.create(WORKER, MACHINE_RUN, request.attemptId, [
        TEST_AGENT.brain,
      ]);
      yield* workers.addWorker(boatAddress);
      yield* executor.preflight(WORKER, [], 1);
      const next = yield* machines.create(
        WORKER,
        MACHINE_RUN,
        AttemptId.make("replacement-attempt"),
        [],
      );
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
        const original = yield* machines.create(WORKER, MACHINE_RUN, request.attemptId, [
          TEST_AGENT.brain,
        ]);
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

it.live.each(["preflight", "first-use"] as const)(
  "reports image preparation during %s and warns about the snapshot once",
  (mode) => {
    const machine = fakeMachine();
    machine.state.docker = "running";
    machine.state.imageOnMachine = false;
    const providers = fakeProviders();
    providers.hetzner.startingReads = 0;
    const logs = capturedLogs();
    return Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      const machines = yield* WorkerMachines;
      if (mode === "first-use") {
        const first = yield* machines.create(WORKER, MACHINE_RUN, request.attemptId, []);
        yield* machines.release(first.hold);
        logs.lines.length = 0;
        logs.warnings.length = 0;
      }
      machine.state.imageOnMachine = false;
      machine.state.beforePull = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(proceed)),
      );
      const creating = yield* machines
        .create(WORKER, MACHINE_RUN, request.attemptId, [])
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const preparing = (yield* machines.machines)[0];
      assert.strictEqual(preparing?.state, "preparing");
      assert.isTrue(preparing !== undefined && Option.isSome(preparing.id));
      assert.lengthOf(
        logs.warnings.filter((line) => line.includes("snapshot lacks the attempt image")),
        1,
      );
      assert.include(logs.warnings.join("\n"), "claude-2.1.311-codex-0.164.0");
      yield* Deferred.succeed(proceed, undefined);
      const grant = yield* Fiber.join(creating);
      assert.strictEqual(Option.isSome(grant.checked), mode === "preflight");
      assert.strictEqual((yield* machines.machines)[0]?.state, "ready");
      assert.lengthOf(
        logs.lines.filter((line) => line.includes("Pulled the attempt image")),
        1,
      );
      yield* machines.release(grant.hold);
    }).pipe(
      Effect.scoped,
      Effect.provide(runtimeOf(machine, providers, hetznerAddress)),
      Effect.provide(logs.layer),
    );
  },
);
