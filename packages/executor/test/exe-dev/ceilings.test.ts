import { assert, describe, it } from "@effect/vitest";
import type * as AttemptChannel from "@usine/core/attempt/channel";
import { type StubParent, StubStorage } from "@usine/durable/testing";
import { Deferred, type Duration, Effect, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";
import { CheckoutRequest, Executor } from "../../src/executor.ts";
import { ATTEMPT_ID, TEST_AGENT, WORKER, fakeSsh, recording, request, runtime } from "./support.ts";

/**
 * Runs `checkout` in one orchestrator process whose parent works quietly,
 * sending nothing into the transcript, then stops that process `after` the
 * parent started.
 */
const stopAfter = (
  ssh: ReturnType<typeof fakeSsh>,
  storage: StubStorage,
  checkout: CheckoutRequest,
  sink: AttemptChannel.Sink,
  after: Duration.Input,
) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const quiet: StubParent = () =>
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
    yield* Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
      const prepared = yield* executor.prepare(checkout);
      const launch = yield* prepared.launch(sink).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust(after);
      yield* Fiber.interrupt(launch);
    }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer, quiet, storage)));
  });

describe("exe.dev ceilings across a restart", () => {
  it.effect(
    "resumes a reattached Attempt's wall clock from the time it ran before each restart and stops its parent task when it trips",
    () => {
      const ssh = fakeSsh();
      const storage = new StubStorage();
      const minute = new CheckoutRequest({ ...request, maxAttemptMinutes: Option.some(1) });
      const reattach = new CheckoutRequest({ ...minute, reattach: true });
      const { transcript, sink } = recording();
      return Effect.gen(function* () {
        // The parent works quietly for 30 of its 60 seconds, then the process stops.
        yield* stopAfter(ssh, storage, minute, sink, "30 seconds");
        yield* TestClock.adjust("10 minutes");
        // Reattached, it works 12 more seconds, then the process stops again.
        yield* stopAfter(ssh, storage, reattach, sink, "12 seconds");
        yield* TestClock.adjust("10 minutes");
        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
          const prepared = yield* executor.prepare(reattach);
          const launch = yield* prepared.launch(sink).pipe(Effect.forkChild);
          // One second at a time, so the guard arms its next timer after the warning.
          for (let second = 0; second < 17; second += 1) yield* TestClock.adjust("1 second");
          assert.strictEqual(launch.pollUnsafe(), undefined);
          yield* TestClock.adjust("1 second");
          const failure = yield* Fiber.join(launch).pipe(Effect.flip);
          assert(failure._tag === "RunawayFailure");
          assert.strictEqual(failure.ceiling, "wall-clock");
          assert.strictEqual(storage.tasks.get(ATTEMPT_ID)?.state._tag, "canceled");
        }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer, () => Effect.never, storage)));
        assert.deepStrictEqual(
          transcript.flatMap(([, envelope]) =>
            envelope._tag === "InboundEnvelope" && envelope.payload._tag === "Steer"
              ? [envelope.payload.message]
              : [],
          ),
          ["0.8 of 1 minutes used by this Attempt; commit and push your work now."],
        );
      });
    },
  );

  it.effect(
    "trips a reattached Attempt whose earlier run spent its lowered time ceiling and stops its parent task",
    () => {
      const ssh = fakeSsh();
      const storage = new StubStorage();
      const { sink } = recording();
      return Effect.gen(function* () {
        const twoMinutes = new CheckoutRequest({ ...request, maxAttemptMinutes: Option.some(2) });
        yield* stopAfter(ssh, storage, twoMinutes, sink, "70 seconds");
        // The operator lowered the ceiling to one minute before the restart.
        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
          const prepared = yield* executor.prepare(
            new CheckoutRequest({ ...request, maxAttemptMinutes: Option.some(1), reattach: true }),
          );
          const failure = yield* prepared.launch(sink).pipe(Effect.flip);
          assert(failure._tag === "RunawayFailure");
          assert.strictEqual(failure.ceiling, "wall-clock");
          assert.strictEqual(storage.tasks.get(ATTEMPT_ID)?.state._tag, "canceled");
        }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer, () => Effect.never, storage)));
      });
    },
  );
});
