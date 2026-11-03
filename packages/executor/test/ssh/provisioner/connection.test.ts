import { assert, describe, it } from "@effect/vitest";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AttemptId } from "@usine/core/attempt";
import { completes, type StubParent } from "@usine/durable/testing";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { CheckoutRequest, Executor, WorkerMachines } from "../../../src/executor.ts";
import { remoteCommandsFor } from "../../../src/remote/commands.ts";
import { fakeMachine, LOCAL_TEMPORARY_DIRECTORY, request, TEST_AGENT, WORKER } from "../support.ts";
import { fakeProviders } from "./fake-providers.ts";
import { MACHINE_RUN, boatAddress, RUN, runtimeOf, sink } from "./fixtures.ts";

const observing = (notices: Array<AttemptChannel.WorkerNotice>) => ({
  ...sink,
  append: (_direction: AttemptChannel.Direction, envelope: AttemptChannel.Envelope) =>
    Effect.sync(() => {
      if (
        envelope._tag === "OutboundEnvelope" &&
        (envelope.payload._tag === "WorkerUnresponsive" ||
          envelope.payload._tag === "WorkerResponsive")
      )
        notices.push(envelope.payload);
    }),
});

describe("Boat SSH connection recovery", () => {
  it.effect("reconnects after an endpoint moves and updates existing attempt shells", () => {
    const machine = fakeMachine();
    machine.state.localFiles.set("/keys/usine_boat.pub", "ssh-ed25519 AAAAOperatorKey usine\n");
    const providers = fakeProviders();
    providers.boat.provisioningReads = 0;
    providers.boat.sshEndpoint = "203.0.113.10:22001";
    const notices: Array<AttemptChannel.WorkerNotice> = [];
    return Effect.gen(function* () {
      const working = yield* Deferred.make<void>();
      const done = yield* Deferred.make<void>();
      const parent: StubParent = (context) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(working, undefined);
          yield* Deferred.await(done);
          assert(context.request.host._tag === "RemoteShell");
          const result = yield* (yield* remoteCommandsFor.pipe(Effect.provide(machine.layer)))
            .inspect("launch", context.request.host, "true", [])
            .pipe(Effect.orDie);
          assert.strictEqual(result.exitCode, 0, "an existing shell uses the recovered endpoint");
          return yield* completes(context);
        });
      yield* Effect.gen(function* () {
        const executor = yield* Executor;
        const machines = yield* WorkerMachines;
        const grant = yield* machines.create(WORKER, MACHINE_RUN, request.attemptId, [
          TEST_AGENT.brain,
        ]);
        const launch = yield* (yield* executor.prepare(request))
          .launch(observing(notices))
          .pipe(Effect.forkChild);
        yield* Deferred.await(working);

        machine.state.closedSshEndpoints.add("203.0.113.10:22001");
        providers.boat.sshEndpoint = "203.0.113.11:22002";
        yield* TestClock.adjust("1 minute");
        assert.lengthOf(
          notices.filter(({ _tag }) => _tag === "WorkerUnresponsive"),
          0,
        );
        assert.isTrue(
          providers.calls.filter(
            ({ method, path }) => method === "GET" && path === `/sandboxes/${grant.id}`,
          ).length > 1,
        );

        yield* Deferred.succeed(done, undefined);
        assert.strictEqual((yield* Fiber.join(launch)).message, `Completed: ${request.task}`);
        assert.strictEqual(
          machine.state.localFiles.get(`${LOCAL_TEMPORARY_DIRECTORY}/boat-${grant.id}`),
          `usine-boat-${grant.id} ${providers.boat.hostKey ?? ""}\n`,
        );
        yield* machines.release(grant.hold);
        assert.isFalse(
          machine.state.localFiles.has(`${LOCAL_TEMPORARY_DIRECTORY}/boat-${grant.id}.ssh-config`),
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(runtimeOf(machine, providers, boatAddress, { parent })),
      );
    });
  });

  it.effect(
    "keeps probing both endpoints while running and recovers when the original port returns",
    () => {
      const machine = fakeMachine();
      machine.state.localFiles.set("/keys/usine_boat.pub", "ssh-ed25519 AAAAOperatorKey usine\n");
      const providers = fakeProviders();
      providers.boat.provisioningReads = 0;
      providers.boat.sshEndpoint = "203.0.113.10:22001";
      const notices: Array<AttemptChannel.WorkerNotice> = [];
      return Effect.gen(function* () {
        const working = yield* Deferred.make<void>();
        const done = yield* Deferred.make<void>();
        const parent: StubParent = (context) =>
          Deferred.succeed(working, undefined).pipe(
            Effect.andThen(Deferred.await(done)),
            Effect.andThen(completes(context)),
          );
        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          const machines = yield* WorkerMachines;
          const grant = yield* machines.create(WORKER, MACHINE_RUN, request.attemptId, [
            TEST_AGENT.brain,
          ]);
          const launch = yield* (yield* executor.prepare(request))
            .launch(observing(notices))
            .pipe(Effect.forkChild);
          yield* Deferred.await(working);

          machine.state.closedSshEndpoints.add("203.0.113.10:22001");
          providers.boat.sshEndpoint = "203.0.113.10:22002";
          yield* TestClock.adjust("1 minute");
          machine.state.closedSshEndpoints.add("203.0.113.10:22002");
          for (let probe = 0; probe < 3; probe++) yield* TestClock.adjust("1 minute");
          const unanswered = notices.filter((notice) => notice._tag === "WorkerUnresponsive");
          assert.deepStrictEqual(
            unanswered.map((notice) => notice.unansweredProbes),
            [1, 3],
          );
          const reads = providers.calls.filter(
            ({ method, path }) => method === "GET" && path === `/sandboxes/${grant.id}`,
          );
          assert.isAtLeast(reads.length, 5, "the provider is checked on every failed probe");

          providers.boat.readFails = { status: 503, code: "unavailable", message: "Try later" };
          yield* TestClock.adjust("1 minute");
          providers.boat.readFails = undefined;

          machine.state.closedSshEndpoints.delete("203.0.113.10:22001");
          yield* TestClock.adjust("1 minute");
          const recovered = notices.at(-1);
          assert(recovered?._tag === "WorkerResponsive" && recovered.recovered);
          yield* Deferred.succeed(done, undefined);
          assert.strictEqual((yield* Fiber.join(launch)).message, `Completed: ${request.task}`);
          yield* machines.release(grant.hold);
        }).pipe(
          Effect.scoped,
          Effect.provide(runtimeOf(machine, providers, boatAddress, { parent })),
        );
      });
    },
  );

  for (const loss of ["deleted", "archived"]) {
    it.effect(`fails a ${loss} sandbox as infrastructure loss and permits a fresh machine`, () => {
      const machine = fakeMachine();
      machine.state.localFiles.set("/keys/usine_boat.pub", "ssh-ed25519 AAAAOperatorKey usine\n");
      const providers = fakeProviders();
      providers.boat.provisioningReads = 0;
      providers.boat.sshEndpoint = "203.0.113.10:22001";
      const notices: Array<AttemptChannel.WorkerNotice> = [];
      return Effect.gen(function* () {
        const working = yield* Deferred.make<void>();
        const parent: StubParent = () =>
          Deferred.succeed(working, undefined).pipe(Effect.andThen(Effect.never));
        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          const machines = yield* WorkerMachines;
          const grant = yield* machines.create(WORKER, MACHINE_RUN, request.attemptId, [
            TEST_AGENT.brain,
          ]);
          const launch = yield* (yield* executor.prepare(request))
            .launch(observing(notices))
            .pipe(Effect.forkChild);
          yield* Deferred.await(working);
          machine.state.closedSshEndpoints.add("203.0.113.10:22001");
          const sandbox = providers.boat.sandboxes.get(grant.id);
          assert(sandbox !== undefined);
          if (loss === "deleted") providers.boat.sandboxes.delete(grant.id);
          else sandbox.state = "archived";
          yield* TestClock.adjust("1 minute");
          const failure = yield* Fiber.join(launch).pipe(Effect.flip);
          assert.strictEqual(failure._tag, "InfraFailure");
          assert.include(failure.message, grant.id);
          assert.lengthOf(
            notices.filter(({ _tag }) => _tag === "WorkerUnresponsive"),
            0,
          );

          machine.state.closedSshEndpoints.clear();
          const next = yield* machines.create(
            WORKER,
            MACHINE_RUN,
            AttemptId.make(`${RUN}/execute/2`),
            [TEST_AGENT.brain],
          );
          assert.notStrictEqual(next.id, grant.id);
          yield* machines.release(next.hold);
          yield* machines.release(grant.hold);
        }).pipe(
          Effect.scoped,
          Effect.provide(runtimeOf(machine, providers, boatAddress, { parent })),
        );
      });
    });
  }

  it.effect("does not drain another sandbox on the same SSH host when one disappears", () => {
    const machine = fakeMachine();
    machine.state.localFiles.set("/keys/usine_boat.pub", "ssh-ed25519 AAAAOperatorKey usine\n");
    const providers = fakeProviders();
    providers.boat.provisioningReads = 0;
    providers.boat.sshEndpoint = "203.0.113.10:22001";
    const second = CheckoutRequest.make({
      ...request,
      attemptId: AttemptId.make(`${RUN}/execute/2`),
    });
    return Effect.gen(function* () {
      const firstWorking = yield* Deferred.make<void>();
      const secondWorking = yield* Deferred.make<void>();
      const done = yield* Deferred.make<void>();
      const parent: StubParent = (context) =>
        Deferred.succeed(
          context.request.spec.attemptId === request.attemptId ? firstWorking : secondWorking,
          undefined,
        ).pipe(Effect.andThen(Deferred.await(done)), Effect.andThen(completes(context)));
      yield* Effect.gen(function* () {
        const executor = yield* Executor;
        const machines = yield* WorkerMachines;
        const first = yield* machines.create(WORKER, MACHINE_RUN, request.attemptId, [
          TEST_AGENT.brain,
        ]);
        const firstLaunch = yield* (yield* executor.prepare(request))
          .launch(sink)
          .pipe(Effect.forkChild);
        yield* Deferred.await(firstWorking);
        providers.boat.sshEndpoint = "203.0.113.10:22002";
        const other = yield* machines.create(WORKER, MACHINE_RUN, second.attemptId, [
          TEST_AGENT.brain,
        ]);
        const otherLaunch = yield* (yield* executor.prepare(second))
          .launch(sink)
          .pipe(Effect.forkChild);
        yield* Deferred.await(secondWorking);

        providers.boat.sandboxes.delete(first.id);
        machine.state.closedSshEndpoints.add("203.0.113.10:22001");
        yield* TestClock.adjust("1 minute");
        assert.strictEqual((yield* Fiber.join(firstLaunch).pipe(Effect.flip))._tag, "InfraFailure");
        yield* Deferred.succeed(done, undefined);
        assert.strictEqual((yield* Fiber.join(otherLaunch)).message, `Completed: ${request.task}`);
        yield* machines.release(first.hold);
        yield* machines.release(other.hold);
      }).pipe(
        Effect.scoped,
        Effect.provide(runtimeOf(machine, providers, boatAddress, { parent })),
      );
    });
  });
});
