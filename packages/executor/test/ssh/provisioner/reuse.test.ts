import { jsonKey } from "@usine/core/json-key";
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
import { sharedHarnesses } from "../harnesses.ts";
import { fakeMachine, request, TEST_AGENT, WORKER } from "../support.ts";
import {
  MACHINE_RUN,
  boxdAddress,
  boatAddress,
  hetznerAddress,
  runtimeOf,
  sink,
} from "./fixtures.ts";
import { fakeProviders } from "./fake-providers.ts";

const policy = ProvisionerReuse.make({
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

for (const address of [hetznerAddress, boatAddress, boxdAddress]) {
  assert(address.machine._tag === "Provisioned");
  const provider = address.machine.provisioner.provider;
  describe(`${provider} machine reuse`, () => {
    it.live.each(["docker", "podman"])(
      "reuses only a released %s machine, updates its attempt identity, and retires it at the attempt limit",
      (containerRuntime) => {
        const machine = machineFixture();
        if (containerRuntime === "podman") {
          machine.state.docker = "absent";
          machine.state.podmanInfo = jsonKey({
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
        const records = new Map<AttemptId, SshWorkerAddress>();
        return Effect.gen(function* () {
          const machines = yield* WorkerMachines;
          const executor = yield* Executor;
          const first = yield* machines.create(WORKER, MACHINE_RUN, request.attemptId, [
            TEST_AGENT.brain,
          ]);
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* (yield* executor.prepare(request)).launch(sink);
            }),
          );
          assert.isTrue(records.has(request.attemptId));
          yield* machines.release(first.hold);
          yield* machines.release(first.hold);
          assert.strictEqual((yield* machines.machines)[0]?.state, "idle");
          assert.strictEqual(machine.state.containers.size, 0);
          assert.strictEqual(machine.state.credentials.size, 0);
          assert.strictEqual(records.size, 0, "reset removes the completed attempt connection");
          const reset = machine.state.calls.find(
            ({ line }) =>
              line.startsWith("exec 'rm' '-rf'") && line.includes("/container-checkouts'"),
          );
          assert(reset !== undefined);
          assert.include(
            reset.line,
            "/shared-client'",
            "reset removes every registered harness home before reusing the machine",
          );
          assert.include(reset.line, "/codex'");
          assert.include(reset.line, "/claude'", "reset removes orphan Claude session directories");
          if (provider === "boxd") providers.boxd.timers.length = 0;
          const reused = yield* machines.create(WORKER, MACHINE_RUN, second, [TEST_AGENT.brain]);
          if (provider === "boxd") {
            assert.deepStrictEqual(providers.boxd.timers, [
              { id: first.id, kind: "hibernate", seconds: 0 },
              { id: first.id, kind: "suspend", seconds: 0 },
            ]);
          }
          assert.isTrue(records.has(second));
          assert.strictEqual(reused.id, first.id);
          assert.notEqual(reused.hold, first.hold);
          assert.strictEqual((yield* machines.machines)[0]?.attempts, 2);
          assert.strictEqual((yield* machines.starts)[0]?.count, 1);
          const assignment = providers.calls.find(
            ({ method }) => method === (provider === "boat" ? "PATCH" : "PUT"),
          );
          const json1 = jsonKey(
            provider === "boxd"
              ? [...providers.boxd.machines.values()].map((machine) => machine.labels)
              : assignment?.body,
          );
          assert.include(json1, attemptTag(second));
          yield* machines.release(first.hold);
          assert.strictEqual(
            (yield* machines.machines)[0]?.state,
            "ready",
            "a repeated old release cannot release a new attempt",
          );
          yield* machines.release(reused.hold);
          const currentMachines = yield* machines.machines;
          assert.lengthOf(currentMachines, 0);
          assert.strictEqual(records.size, 0, "deletion leaves no previous attempt connections");
          const fresh = yield* machines.create(WORKER, MACHINE_RUN, third, [TEST_AGENT.brain]);
          assert.notEqual(fresh.id, first.id);
          assert.strictEqual((yield* machines.starts)[0]?.count, 2);
          yield* machines.release(fresh.hold);
        }).pipe(
          Effect.scoped,
          Effect.provide(
            runtimeOf(machine, providers, reuseAddress(address), {
              harnesses: sharedHarnesses,
              attemptConnections: {
                read: (id) => Effect.sync(() => Option.fromNullishOr(records.get(id))),
                write: (id, connection) => Effect.sync(() => void records.set(id, connection)),
                remove: (id) => Effect.sync(() => void records.delete(id)),
              },
            }),
          ),
        );
      },
    );

    it.live("creates a fresh machine after release when reuse is disabled", () => {
      const machine = machineFixture();
      const providers = fakeProviders();
      return Effect.gen(function* () {
        const machines = yield* WorkerMachines;
        const first = yield* machines.create(WORKER, MACHINE_RUN, request.attemptId, []);
        yield* machines.release(first.hold);
        const next = yield* machines.create(WORKER, MACHINE_RUN, second, []);
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
        const first = yield* machines.create(WORKER, MACHINE_RUN, request.attemptId, [
          TEST_AGENT.brain,
        ]);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const prepared = yield* executor.prepare(request);
            machine.state.containerRemovalFails = true;
            yield* prepared.launch(sink);
          }),
        );
        machine.state.containerRemovalFails = false;
        yield* machines.release(first.hold);
        const currentMachines = yield* machines.machines;
        assert.lengthOf(currentMachines, 0);
        const next = yield* machines.create(WORKER, MACHINE_RUN, second, []);
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
    const first = yield* machines.create(WORKER, MACHINE_RUN, request.attemptId, []);
    yield* machines.release(first.hold);
    yield* TestClock.adjust("2 hours");
    assert.strictEqual(providers.hetzner.servers.size, 0);
    const next = yield* machines.create(WORKER, MACHINE_RUN, second, []);
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
    const first = yield* machines.create(WORKER, MACHINE_RUN, request.attemptId, []);
    yield* machines.release(first.hold);
    machine.state.rootWritable = false;
    yield* machines.create(WORKER, MACHINE_RUN, second, []).pipe(Effect.flip);
    assert.strictEqual(providers.hetzner.servers.size, 0);
    machine.state.rootWritable = true;
    const next = yield* machines.create(WORKER, MACHINE_RUN, second, []);
    assert.notEqual(next.id, first.id);
    yield* machines.release(next.hold);
  }).pipe(
    Effect.scoped,
    Effect.provide(runtimeOf(machine, providers, reuseAddress(hetznerAddress))),
  );
});

for (const transition of ["removed", "idle revision", "active revision"] as const) {
  it.live(`retires reused machines on a connection change (${transition})`, () => {
    const machine = machineFixture();
    const providers = fakeProviders();
    const address = reuseAddress(hetznerAddress);
    return Effect.gen(function* () {
      const machines = yield* WorkerMachines;
      const workers = yield* SshWorkers;
      const first = yield* machines.create(WORKER, MACHINE_RUN, request.attemptId, []);
      if (transition !== "active revision") yield* machines.release(first.hold);
      if (transition === "removed") yield* workers.removeWorker(WORKER);
      yield* workers.addWorker({ ...address, root: WorkerRoot.make("/replacement") });
      if (transition === "active revision") {
        assert.strictEqual(
          providers.hetzner.servers.size,
          1,
          "the active attempt keeps its machine",
        );
        yield* machines.release(first.hold);
      }
      assert.strictEqual(providers.hetzner.servers.size, 0);
      const next = yield* machines.create(WORKER, MACHINE_RUN, second, []);
      assert.notEqual(next.id, first.id);
      yield* machines.release(next.hold);
    }).pipe(Effect.scoped, Effect.provide(runtimeOf(machine, providers, address)));
  });
}

it.live("preserves machine-start counts across executor restarts and deletion", () => {
  const machine = machineFixture();
  const providers = fakeProviders();
  const create = Effect.gen(function* () {
    const machines = yield* WorkerMachines;
    const grant = yield* machines.create(WORKER, MACHINE_RUN, request.attemptId, []);
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
    const first = yield* machines.create(WORKER, MACHINE_RUN, request.attemptId, []);
    yield* machines.release(first.hold);
    const grants = yield* Effect.all(
      [
        machines.create(WORKER, MACHINE_RUN, second, []),
        machines.create(WORKER, MACHINE_RUN, third, []),
      ],
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
    const failure = yield* machines
      .create(WORKER, MACHINE_RUN, request.attemptId, [])
      .pipe(Effect.flip);
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
    const first = yield* machines.create(WORKER, MACHINE_RUN, request.attemptId, []);
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
