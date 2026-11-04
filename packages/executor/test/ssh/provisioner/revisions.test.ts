import { assert, it } from "@effect/vitest";
import { RemoteShell } from "@usine/agents/child-host";
import { AttemptId } from "@usine/core/attempt";
import { completes, type StubParent } from "@usine/durable/testing";
import { Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { CheckoutRequest, Executor, WorkerMachines } from "../../../src/executor.ts";
import { SshWorkers } from "../../../src/ssh/ssh.ts";
import { ADDRESS, DESTINATION, TEST_AGENT, WORKER, fakeMachine, request } from "../support.ts";
import { fakeProviders } from "./fake-providers.ts";
import { MACHINE_RUN, hetznerAddress, runtimeOf, sink } from "./fixtures.ts";

it.effect("launches an allocated VM after its worker becomes fixed while the VM starts", () => {
  const machine = fakeMachine();
  const providers = fakeProviders();
  const destinations: Array<string> = [];
  const parent: StubParent = (context) => {
    assert(Schema.is(RemoteShell)(context.request.host));
    destinations.push(context.request.host.destination);
    return completes(context);
  };
  return Effect.gen(function* () {
    const machines = yield* WorkerMachines;
    const executor = yield* Executor;
    const creating = yield* machines
      .create(WORKER, MACHINE_RUN, request.attemptId, [TEST_AGENT.brain])
      .pipe(Effect.forkChild);
    while (providers.hetzner.servers.size === 0) yield* Effect.yieldNow;
    const [server] = providers.hetzner.servers.values();
    assert(server?.publicIp !== undefined);
    assert.strictEqual(server.status, "initializing");
    assert.strictEqual((yield* machines.machines)[0]?.state, "creating");

    yield* (yield* SshWorkers).addWorker(ADDRESS);
    yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
    yield* TestClock.adjust("10 millis");
    const grant = yield* Fiber.join(creating);
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* (yield* executor.prepare(request)).launch(sink);
      }),
    );
    assert.deepStrictEqual(destinations, [`usine@${server.publicIp}`]);
    yield* machines.release(grant.hold);
    assert.strictEqual(providers.hetzner.servers.size, 0);
    assert.isTrue(
      providers.calls.some(
        ({ method, path }) => method === "DELETE" && path === `/servers/${server.id}`,
      ),
    );

    const next = CheckoutRequest.make({ ...request, attemptId: AttemptId.make("fixed-attempt") });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* (yield* executor.prepare(next)).launch(sink);
      }),
    );
    assert.deepStrictEqual(destinations, [`usine@${server.publicIp}`, DESTINATION]);
    assert.lengthOf(
      providers.calls.filter(({ method, path }) => method === "POST" && path === "/servers"),
      1,
    );
  }).pipe(Effect.scoped, Effect.provide(runtimeOf(machine, providers, hetznerAddress, { parent })));
});
