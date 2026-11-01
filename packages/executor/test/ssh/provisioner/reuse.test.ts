import { assert, describe, it } from "@effect/vitest";
import { AttemptId } from "@usine/core/attempt";
import {
  MachineAttemptLimit,
  MachineMaxAge,
  ProvisionerReuse,
  WorkerRoot,
} from "@usine/core/worker";
import { Effect, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";
import { Executor, WorkerMachines } from "../../../src/executor.ts";
import type { SshWorkerAddress } from "../../../src/ssh/model.ts";
import { SshWorkers } from "../../../src/ssh/ssh.ts";
import { attemptTag } from "../../../src/ssh/provisioner/model.ts";
import { fakeMachine, request, TEST_AGENT, WORKER } from "../support.ts";
import { boatAddress, hetznerAddress, RUN, runtimeOf, sink } from "./fixtures.ts";
import { fakeProviders } from "./fake-providers.ts";

const policy = new ProvisionerReuse({
  attempts: MachineAttemptLimit.make(2),
  maxAge: MachineMaxAge.make("2h"),
});
const second = AttemptId.make("second/execute/1");
const third = AttemptId.make("third/execute/1");
const reuseAddress = (address: SshWorkerAddress): SshWorkerAddress => {
  assert(address.machine._tag === "Provisioned");
  return {
    ...address,
    machine: {
      ...address.machine,
      provisioner: { ...address.machine.provisioner, reuse: Option.some(policy) },
    },
  };
};
const machineFixture = () => {
  const machine = fakeMachine();
  machine.state.docker = "running";
  machine.state.localFiles.set("/keys/usine_boat.pub", "ssh-ed25519 AAAATest");
  return machine;
};

for (const address of [hetznerAddress, boatAddress]) {
  assert(address.machine._tag === "Provisioned");
  const provider = address.machine.provisioner.provider;
  describe(`${provider} machine reuse`, () => {
    it.live.each(["docker", "podman"])(
      "reuses only a released %s machine, updates its attempt identity, and retires it at the attempt limit",
      (containerRuntime) => {
        const machine = machineFixture();
        if (containerRuntime === "podman") {
          machine.state.docker = "absent";
          machine.state.podmanInfo = JSON.stringify({
            version: { Version: "5.4.2" },
            host: {
              security: { rootless: true },
              serviceIsRemote: false,
              cgroupVersion: "v2",
              cgroupManager: "systemd",
              cgroupControllers: ["cpu", "memory", "pids"],
              kernel: "6.12.43+deb13-amd64",
              ociRuntime: { name: "crun", version: "crun version 1.21" },
            },
          });
        }
        const providers = fakeProviders();
        return Effect.gen(function* () {
          const machines = yield* WorkerMachines;
          const executor = yield* Executor;
          const first = yield* machines.create(WORKER, RUN, request.attemptId, [TEST_AGENT.brain]);
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* (yield* executor.prepare(request)).launch(sink);
            }),
          );
          yield* machines.release(first.hold);
          yield* machines.release(first.hold);
          assert.strictEqual((yield* machines.machines)[0]?.state, "idle");
          assert.strictEqual(machine.state.containers.size, 0);
          assert.strictEqual(machine.state.credentials.size, 0);
          const reused = yield* machines.create(WORKER, RUN, second, [TEST_AGENT.brain]);
          assert.strictEqual(reused.id, first.id);
          assert.notEqual(reused.hold, first.hold);
          assert.strictEqual((yield* machines.machines)[0]?.attempts, 2);
          assert.strictEqual((yield* machines.starts)[0]?.count, 1);
          const assignment = providers.calls.find(
            ({ method }) => method === (provider === "boat" ? "PATCH" : "PUT"),
          );
          assert.include(JSON.stringify(assignment?.body), attemptTag(second));
          yield* machines.release(first.hold);
          assert.strictEqual(
            (yield* machines.machines)[0]?.state,
            "ready",
            "a repeated old release cannot release a new attempt",
          );
          yield* machines.release(reused.hold);
          assert.lengthOf(yield* machines.machines, 0);
          const fresh = yield* machines.create(WORKER, RUN, third, [TEST_AGENT.brain]);
          assert.notEqual(fresh.id, first.id);
          assert.strictEqual((yield* machines.starts)[0]?.count, 2);
          yield* machines.release(fresh.hold);
        }).pipe(
          Effect.scoped,
          Effect.provide(runtimeOf(machine, providers, reuseAddress(address))),
        );
      },
    );

    it.live("creates a fresh machine after release when reuse is disabled", () => {
      const machine = machineFixture();
      const providers = fakeProviders();
      return Effect.gen(function* () {
        const machines = yield* WorkerMachines;
        const first = yield* machines.create(WORKER, RUN, request.attemptId, []);
        yield* machines.release(first.hold);
        const next = yield* machines.create(WORKER, RUN, second, []);
        assert.notEqual(next.id, first.id);
        yield* machines.release(next.hold);
      }).pipe(Effect.scoped, Effect.provide(runtimeOf(machine, providers, address)));
    });

    it.live("retires a machine after a transient container cleanup failure", () => {
      const machine = machineFixture();
      const providers = fakeProviders();
      return Effect.gen(function* () {
        const machines = yield* WorkerMachines;
        const executor = yield* Executor;
        const first = yield* machines.create(WORKER, RUN, request.attemptId, [TEST_AGENT.brain]);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const prepared = yield* executor.prepare(request);
            machine.state.containerRemovalFails = true;
            yield* prepared.launch(sink);
          }),
        );
        machine.state.containerRemovalFails = false;
        yield* machines.release(first.hold);
        assert.lengthOf(yield* machines.machines, 0);
        const next = yield* machines.create(WORKER, RUN, second, []);
        assert.notEqual(next.id, first.id);
        yield* machines.release(next.hold);
      }).pipe(Effect.scoped, Effect.provide(runtimeOf(machine, providers, reuseAddress(address))));
    });
  });
}

it.effect("retires an idle machine at its age limit without waiting for another attempt", () => {
  const machine = machineFixture();
  const providers = fakeProviders();
  providers.hetzner.startingReads = 0;
  return Effect.gen(function* () {
    const machines = yield* WorkerMachines;
    const first = yield* machines.create(WORKER, RUN, request.attemptId, []);
    yield* machines.release(first.hold);
    yield* TestClock.adjust("2 hours");
    assert.strictEqual(providers.hetzner.servers.size, 0);
    const next = yield* machines.create(WORKER, RUN, second, []);
    assert.notEqual(next.id, first.id);
    yield* machines.release(next.hold);
  }).pipe(
    Effect.scoped,
    Effect.provide(runtimeOf(machine, providers, reuseAddress(hetznerAddress))),
  );
});

it.live("retires a reused machine when preflight fails and retries on a fresh one", () => {
  const machine = machineFixture();
  const providers = fakeProviders();
  return Effect.gen(function* () {
    const machines = yield* WorkerMachines;
    const first = yield* machines.create(WORKER, RUN, request.attemptId, []);
    yield* machines.release(first.hold);
    machine.state.rootWritable = false;
    yield* machines.create(WORKER, RUN, second, []).pipe(Effect.flip);
    assert.strictEqual(providers.hetzner.servers.size, 0);
    machine.state.rootWritable = true;
    const next = yield* machines.create(WORKER, RUN, second, []);
    assert.notEqual(next.id, first.id);
    yield* machines.release(next.hold);
  }).pipe(
    Effect.scoped,
    Effect.provide(runtimeOf(machine, providers, reuseAddress(hetznerAddress))),
  );
});

it.live("retires idle machines before a worker's connection is replaced", () => {
  const machine = machineFixture();
  const providers = fakeProviders();
  const address = reuseAddress(hetznerAddress);
  return Effect.gen(function* () {
    const machines = yield* WorkerMachines;
    const workers = yield* SshWorkers;
    const first = yield* machines.create(WORKER, RUN, request.attemptId, []);
    yield* machines.release(first.hold);
    yield* workers.removeWorker(WORKER);
    assert.strictEqual(providers.hetzner.servers.size, 0);
    yield* workers.addWorker({ ...address, root: WorkerRoot.make("/replacement") });
    const next = yield* machines.create(WORKER, RUN, second, []);
    assert.notEqual(next.id, first.id);
    yield* machines.release(next.hold);
  }).pipe(Effect.scoped, Effect.provide(runtimeOf(machine, providers, address)));
});

it.live("preserves machine-start counts across executor restarts and deletion", () => {
  const machine = machineFixture();
  const providers = fakeProviders();
  const create = Effect.gen(function* () {
    const machines = yield* WorkerMachines;
    const grant = yield* machines.create(WORKER, RUN, request.attemptId, []);
    yield* machines.release(grant.hold);
    return yield* machines.starts;
  });
  return Effect.gen(function* () {
    yield* create.pipe(
      Effect.scoped,
      Effect.provide(runtimeOf(machine, providers, hetznerAddress)),
    );
    const counts = yield* create.pipe(
      Effect.scoped,
      Effect.provide(runtimeOf(machine, providers, hetznerAddress)),
    );
    assert.strictEqual(counts[0]?.count, 2);
  });
});

it.live("assigns an idle machine to only one of two concurrent attempts", () => {
  const machine = machineFixture();
  const providers = fakeProviders();
  return Effect.gen(function* () {
    const machines = yield* WorkerMachines;
    const first = yield* machines.create(WORKER, RUN, request.attemptId, []);
    yield* machines.release(first.hold);
    const grants = yield* Effect.all(
      [machines.create(WORKER, RUN, second, []), machines.create(WORKER, RUN, third, [])],
      { concurrency: "unbounded" },
    );
    assert.notEqual(grants[0].id, grants[1].id);
    assert.include(
      grants.map(({ id }) => id),
      first.id,
    );
    assert.strictEqual((yield* machines.starts)[0]?.count, 2);
    yield* Effect.forEach(grants, ({ hold }) => machines.release(hold));
  }).pipe(
    Effect.scoped,
    Effect.provide(runtimeOf(machine, providers, reuseAddress(hetznerAddress))),
  );
});

it.live("requires container isolation before enabling machine reuse", () => {
  const machine = machineFixture();
  machine.state.docker = "absent";
  const providers = fakeProviders();
  return Effect.gen(function* () {
    const machines = yield* WorkerMachines;
    const failure = yield* machines.create(WORKER, RUN, request.attemptId, []).pipe(Effect.flip);
    assert.strictEqual(failure._tag, "WorkerCapabilityError");
    assert.strictEqual(providers.hetzner.servers.size, 0);
    assert.strictEqual(
      (yield* machines.starts)[0]?.count,
      1,
      "a failed preflight still costs a start",
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(runtimeOf(machine, providers, reuseAddress(hetznerAddress))),
  );
});

it.effect("retires a machine when reset stops responding over SSH", () => {
  const machine = machineFixture();
  const providers = fakeProviders();
  providers.hetzner.startingReads = 0;
  return Effect.gen(function* () {
    const machines = yield* WorkerMachines;
    const first = yield* machines.create(WORKER, RUN, request.attemptId, []);
    machine.state.stalled = true;
    const releasing = yield* machines.release(first.hold).pipe(Effect.forkChild);
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(releasing);
    assert.strictEqual(providers.hetzner.servers.size, 0);
  }).pipe(
    Effect.scoped,
    Effect.provide(runtimeOf(machine, providers, reuseAddress(hetznerAddress))),
  );
});
