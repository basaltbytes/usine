import { assert, it } from "@effect/vitest";
import { AttemptId } from "@usine/core/attempt";
import { WorkerName } from "@usine/core/worker";
import { Effect, Option, Redacted, Layer } from "effect";
import { WorkerMachines } from "../../../src/executor.ts";
import { SshWorkers } from "../../../src/ssh/ssh.ts";
import { boxdDriverFor } from "../../../src/ssh/provisioner/boxd.ts";
import { boatDriverFor } from "../../../src/ssh/provisioner/boat.ts";
import { hetznerDriverFor } from "../../../src/ssh/provisioner/hetzner.ts";
import { capturedLogs, fakeMachine, INSTANCE, request, TEST_AGENT, WORKER } from "../support.ts";
import {
  MACHINE_RUN,
  boxdAddress,
  boatAddress,
  hetznerAddress,
  RUN,
  runtimeOf,
} from "./fixtures.ts";
import { BOAT_TEST_API, fakeProviders, HETZNER_TEST_API } from "./fake-providers.ts";

for (const address of [hetznerAddress, boatAddress, boxdAddress]) {
  if (address.machine._tag !== "Provisioned") continue;
  const settings = address.machine.provisioner;
  const driver =
    settings.provider === "hetzner"
      ? hetznerDriverFor(WORKER, settings, false, HETZNER_TEST_API)
      : settings.provider === "boxd"
        ? boxdDriverFor(WORKER, settings)
        : boatDriverFor(WORKER, settings, "ssh-ed25519 AAAATest", BOAT_TEST_API);
  const tags = {
    instance: INSTANCE,
    worker: WORKER,
    run: RUN,
    process: "earlier",
    attempt: request.attemptId,
    attempts: 1,
  };

  it.live(
    `sweeps a removed ${settings.provider} worker before releasing its token and uses fresh credentials when re-added`,
    () => {
      const machine = fakeMachine();
      machine.state.localFiles.set("/keys/usine_boat.pub", "ssh-ed25519 AAAATest");
      const providers = fakeProviders();
      return Effect.gen(function* () {
        const api = yield* driver;
        yield* api.create("orphan", tags);
        const workers = yield* SshWorkers;
        const machines = yield* WorkerMachines;
        yield* workers.removeWorker(WORKER);
        const entries = yield* api.list(INSTANCE, Option.some(WORKER));
        assert.lengthOf(entries, 0);
        const currentProvisions = yield* machines.provisions(WORKER);
        assert.isFalse(currentProvisions);
        providers[settings.provider].token = "rotated-token";
        yield* workers.addWorker({
          ...address,
          machine: {
            _tag: "Provisioned",
            provisioner: { ...settings, token: Redacted.make("rotated-token") },
          },
        });
        const grant = yield* machines.create(WORKER, MACHINE_RUN, request.attemptId, [
          TEST_AGENT.brain,
        ]);
        assert.isTrue(Option.isSome(grant.checked));
        yield* machines.release(grant.hold);
        const currentMachines = yield* machines.machines;
        assert.lengthOf(currentMachines, 0);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          runtimeOf(machine, providers, address).pipe(Layer.provideMerge(providers.layer)),
        ),
      );
    },
  );

  it.live(
    `warns at startup about unconfigured ${settings.provider} workers without deleting their machines or another instance's`,
    () => {
      const machine = fakeMachine();
      machine.state.localFiles.set("/keys/usine_boat.pub", "ssh-ed25519 AAAATest");
      const providers = fakeProviders();
      const logs = capturedLogs();
      return Effect.gen(function* () {
        const api = yield* driver;
        const removed = yield* api.create("removed", {
          ...tags,
          worker: WorkerName.make("removed-worker"),
        });
        yield* api.create("foreign", { ...tags, instance: "another-instance" });
        yield* api.create("orphan", { ...tags, attempt: AttemptId.make("orphan/execute/1") });
        const machines = yield* WorkerMachines;
        yield* machines.sweep;
        yield* machines.sweep;
        const warnings = logs.lines.filter((line) => line.includes("no configured Worker"));
        assert.lengthOf(warnings, 1);
        assert.include(warnings[0] ?? "", removed.id);
        assert.include(warnings[0] ?? "", "removed-worker");
        const entries = yield* api.list(INSTANCE, Option.none());
        assert.lengthOf(entries, 1);
        const currentEntries = yield* api.list("another-instance", Option.none());
        assert.lengthOf(currentEntries, 1);
        assert.isFalse(logs.lines.some((line) => line.includes(Redacted.value(settings.token))));
      }).pipe(
        Effect.scoped,
        Effect.provide(
          runtimeOf(machine, providers, address).pipe(
            Layer.provideMerge(providers.layer),
            Layer.provideMerge(logs.layer),
          ),
        ),
      );
    },
  );
}

it.live("reports a failed final deletion and still removes the worker configuration", () => {
  const machine = fakeMachine();
  const providers = fakeProviders();
  const logs = capturedLogs();
  return Effect.gen(function* () {
    const machines = yield* WorkerMachines;
    const workers = yield* SshWorkers;
    const grant = yield* machines.create(WORKER, MACHINE_RUN, request.attemptId, [
      TEST_AGENT.brain,
    ]);
    providers.hetzner.deleteFails = { status: 500, code: "server_error", message: "down" };
    yield* machines.release(grant.hold);
    yield* workers.removeWorker(WORKER);
    const currentProvisions = yield* machines.provisions(WORKER);
    assert.isFalse(currentProvisions);
    assert.strictEqual(providers.hetzner.servers.size, 1);
    const currentMachines = yield* machines.machines;
    assert.lengthOf(currentMachines, 0, "removed worker records do not retain its credentials");
    assert.isTrue(
      logs.lines.some(
        (line) =>
          line.includes("final sweep could not delete all machines") && line.includes(INSTANCE),
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      runtimeOf(machine, providers, hetznerAddress).pipe(Layer.provideMerge(logs.layer)),
    ),
  );
});

it.live("removes an ambiguously created machine before retrying the same Attempt", () => {
  const machine = fakeMachine();
  const providers = fakeProviders();
  return Effect.gen(function* () {
    const machines = yield* WorkerMachines;
    providers.hetzner.createAnswerFails = true;
    yield* machines
      .create(WORKER, MACHINE_RUN, request.attemptId, [TEST_AGENT.brain])
      .pipe(Effect.flip);
    assert.strictEqual(providers.hetzner.servers.size, 1);
    providers.hetzner.createAnswerFails = false;
    providers.hetzner.deleteFails = { status: 500, code: "server_error", message: "down" };
    yield* machines
      .create(WORKER, MACHINE_RUN, request.attemptId, [TEST_AGENT.brain])
      .pipe(Effect.flip);
    assert.strictEqual(
      providers.hetzner.servers.size,
      1,
      "failed cleanup creates no second machine",
    );
    providers.hetzner.deleteFails = undefined;
    const grant = yield* machines.create(WORKER, MACHINE_RUN, request.attemptId, [
      TEST_AGENT.brain,
    ]);
    assert.deepStrictEqual([...providers.hetzner.servers.keys()], [Number(grant.id)]);
    yield* machines.release(grant.hold);
    assert.strictEqual(providers.hetzner.servers.size, 0);
  }).pipe(Effect.scoped, Effect.provide(runtimeOf(machine, providers, hetznerAddress)));
});
