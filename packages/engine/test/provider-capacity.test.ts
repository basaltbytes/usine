import { assert, describe, it } from "@effect/vitest";
import { Agent, AgentName } from "@usine/core/agent";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { ProviderCapacityFailure } from "@usine/core/attempt/failure";
import { AgentSessionId, ChildSession, TextOutput } from "@usine/core/agent/session";
import type { RunId } from "@usine/core/run";
import { StepCompletion } from "@usine/core/step/result";
import { WorkerName } from "@usine/core/worker";
import { DateTime, Deferred, Duration, Effect, Layer, Option, Ref } from "effect";
import { TestClock } from "effect/testing";
import { RetryRequest, RunEngine, Submission } from "../src/engine/engine.ts";
import { StepExecutor } from "../src/step-executor.ts";
import { engineLayer, stepResult, submission, testAgent, withInstance } from "./support.ts";

const refusal =
  "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later.";
const codexAgent = Agent.make({
  ...testAgent,
  name: AgentName.make("codex-developer"),
  brain: BrainSpec.make({
    harness: Harness.make("codex"),
    model: ModelId.make("gpt-test"),
    effort: "high",
  }),
});

interface Started {
  readonly runId: RunId;
  readonly harness: string;
  readonly at: number;
}

/**
 * A provider that refuses Claude requests until `limitEndsAt`, in milliseconds since the epoch of
 * the test clock, without a reset time unless `resetsAt` is set. Codex requests always succeed.
 * With `hold`, an accepted Attempt reports its child's first answer, then runs until `hold`.
 */
const scriptedProvider = (
  limitEndsAt: number,
  resetsAt: Option.Option<number> = Option.none(),
  hold: Option.Option<Deferred.Deferred<void>> = Option.none(),
) =>
  Effect.gen(function* () {
    const starts = yield* Ref.make<ReadonlyArray<Started>>([]);
    const leased = yield* Ref.make(0);
    const local = WorkerName.make("local");
    const executor = Layer.succeed(StepExecutor)({
      workers: Effect.succeed([local]),
      isLive: () => Effect.succeed(false),
      outcome: () => Effect.succeedNone,
      recover: () => Effect.succeed("found" as const),
      intervene: () => Effect.void,
      interrupt: () => Effect.void,
      occupy: (worker) => Effect.succeed({ worker, kind: "local", release: Effect.void }),
      sweep: Effect.void,
      discard: () => Effect.void,
      reserve: () =>
        Ref.update(leased, (count) => count + 1).pipe(
          Effect.as({
            worker: local,
            kind: "local" as const,
            release: Ref.update(leased, (count) => count - 1),
          }),
        ),
      execute: (execution, io) =>
        Effect.gen(function* () {
          const at = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
          const { harness } = execution.attempt.brain;
          yield* Ref.update(starts, (seen) => [...seen, { runId: execution.run.id, harness, at }]);
          if (harness === "claude" && at < limitEndsAt)
            return yield* ProviderCapacityFailure.make({
              message: refusal,
              resetsAt: Option.map(resetsAt, (millis) => DateTime.makeUnsafe(millis)),
            });
          if (Option.isSome(hold)) {
            const { attempt } = execution;
            yield* io.append(
              "outbound",
              AttemptChannel.OutboundEnvelope.make({
                version: AttemptChannel.PROTOCOL_VERSION,
                attemptId: attempt.id,
                sequence: AttemptChannel.Sequence.make(1),
                sentAt: DateTime.makeUnsafe(at),
                payload: AttemptChannel.SessionEvent.make({
                  event: TextOutput.make({
                    session: ChildSession.make({
                      id: AgentSessionId.make(`${attempt.id}/child`),
                      parentId: AgentSessionId.make(`${attempt.id}/parent`),
                      agent: attempt.agent,
                      brain: attempt.brain,
                    }),
                    text: "Reading the issue",
                  }),
                }),
              }),
            );
            yield* Deferred.await(hold.value);
          }
          return StepCompletion.fromResult(stepResult("done"));
        }),
    });
    return { starts, leased, executor };
  });

/** Lets the Run fibers run until each Run satisfies `done`. */
const settle = (
  engine: RunEngine["Service"],
  runIds: ReadonlyArray<RunId>,
  done: (state: string) => boolean = () => true,
) =>
  Effect.gen(function* () {
    for (let count = 0; count < 2_000; count += 1) {
      const snapshots = yield* Effect.forEach(runIds, (runId) => engine.inspect(runId));
      const idle = snapshots.every(
        (snapshot) =>
          done(snapshot.run.state._tag) &&
          snapshot.attempts.every((attempt) => Option.isSome(attempt.outcome)),
      );
      if (idle && count > 50) return snapshots;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die("The Runs did not settle");
  });

const minutes = (count: number) => Duration.toMillis(Duration.minutes(count));

const claimed = (engine: RunEngine["Service"], next: Submission) =>
  engine.submit(next).pipe(
    Effect.map((result) => {
      assert(result._tag === "Claimed");
      return result.runId;
    }),
  );

describe("provider capacity without a reset time", () => {
  it.effect(
    "keeps the Runs through a two-hour limit and tests the pool once per backoff step",
    () =>
      withInstance((directory) =>
        Effect.gen(function* () {
          const provider = yield* scriptedProvider(minutes(120));
          yield* Effect.gen(function* () {
            const engine = yield* RunEngine;
            const claude = yield* Effect.forEach([1, 2, 3], (number) =>
              claimed(engine, submission({ number, item: `item-${number}` })),
            );
            const codex = yield* claimed(
              engine,
              Submission.make({ ...submission({ number: 4, item: "item-4" }), agent: codexAgent }),
            );
            const [other] = yield* settle(engine, [codex], (state) => state === "Succeeded");
            assert.strictEqual(other?.run.state._tag, "Succeeded");
            yield* settle(engine, claude);
            const initial = (yield* Ref.get(provider.starts)).filter(
              ({ harness }) => harness === "claude",
            );
            assert.isAtMost(initial.length, 3);
            const waits = yield* engine.capacityWaits;
            assert.strictEqual(waits.length, 1);
            assert.strictEqual(waits[0]?.message, refusal);
            assert.strictEqual(
              DateTime.toEpochMillis(waits[0]?.nextTryAt ?? DateTime.makeUnsafe(0)),
              minutes(5),
            );
            const waitingLeases = yield* Ref.get(provider.leased);
            assert.strictEqual(waitingLeases, 0);

            // Stops a minute before and at each expected test of the pool, then past the limit.
            let elapsed = 0;
            for (const checkpoint of [4, 5, 19, 20, 49, 50, 109, 110, 169, 170, 240]) {
              yield* TestClock.adjust(Duration.minutes(checkpoint - elapsed));
              elapsed = checkpoint;
              yield* settle(engine, claude);
            }

            const finished = yield* Effect.forEach(claude, (runId) => engine.inspect(runId));
            for (const snapshot of finished) {
              assert.strictEqual(snapshot.run.state._tag, "Succeeded");
              assert.isTrue(
                snapshot.attempts.every(
                  (attempt) =>
                    Option.isNone(attempt.outcome) ||
                    attempt.outcome.value._tag !== "Failed" ||
                    attempt.outcome.value.failure._tag === "ProviderCapacityFailure",
                ),
              );
            }
            const later = (yield* Ref.get(provider.starts))
              .filter(({ harness, at }) => harness === "claude" && at > 0)
              .map(({ at }) => at);
            // One Attempt tests the pool at 5, 20, 50, and 110 minutes; the one at 170 minutes,
            // within one 60-minute step of the limit's end, succeeds and releases the others.
            assert.deepStrictEqual(later, [
              minutes(5),
              minutes(20),
              minutes(50),
              minutes(110),
              minutes(170),
              minutes(170),
              minutes(170),
            ]);
            const released = yield* engine.capacityWaits;
            assert.deepStrictEqual(released, []);
            const leases = yield* Ref.get(provider.leased);
            assert.strictEqual(leases, 0);
          }).pipe(Effect.provide(engineLayer(directory, provider.executor)));
        }),
      ),
    { timeout: 120_000 },
  );

  it.effect(
    "releases the waiting Runs at the first answer of the Attempt that tests the pool",
    () =>
      withInstance((directory) =>
        Effect.gen(function* () {
          const hold = yield* Deferred.make<void>();
          const provider = yield* scriptedProvider(minutes(10), Option.none(), Option.some(hold));
          yield* Effect.gen(function* () {
            const engine = yield* RunEngine;
            const runs = yield* Effect.forEach([1, 2], (number) =>
              claimed(engine, submission({ number, item: `item-${number}` })),
            );
            yield* settle(engine, runs);
            yield* TestClock.adjust(Duration.minutes(5));
            yield* settle(engine, runs);
            yield* TestClock.adjust(Duration.minutes(15));
            for (let count = 0; count < 500; count += 1) {
              const open = (yield* Effect.forEach(runs, (runId) => engine.inspect(runId))).filter(
                (snapshot) => Option.isNone(snapshot.attempts.at(-1)?.outcome ?? Option.none()),
              );
              if (open.length === runs.length) break;
              yield* Effect.yieldNow;
            }
            const accepted = (yield* Ref.get(provider.starts))
              .filter(({ at }) => at === minutes(20))
              .map(({ runId }) => runId)
              .sort();
            assert.deepStrictEqual(accepted, [...runs].sort());
            const released = yield* engine.capacityWaits;
            assert.deepStrictEqual(released, []);
            yield* Deferred.succeed(hold, undefined);
            const done = yield* settle(engine, runs, (state) => state === "Succeeded");
            assert.lengthOf(done, 2);
          }).pipe(Effect.provide(engineLayer(directory, provider.executor)));
        }),
      ),
  );

  it.effect("waits until a reported reset time", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const provider = yield* scriptedProvider(minutes(180), Option.some(minutes(180)));
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const runId = yield* claimed(engine, submission({ number: 1 }));
          yield* settle(engine, [runId]);
          yield* TestClock.adjust(Duration.minutes(179));
          yield* settle(engine, [runId]);
          assert.strictEqual((yield* Ref.get(provider.starts)).length, 1);
          yield* TestClock.adjust(Duration.minutes(1));
          const [done] = yield* settle(engine, [runId], (state) => state === "Succeeded");
          assert.strictEqual(done?.attempts.length, 2);
          assert.strictEqual(
            Option.getOrNull(done?.attempts[1]?.start ?? Option.none())?._tag,
            "ProviderRetry",
          );
        }).pipe(Effect.provide(engineLayer(directory, provider.executor)));
      }),
    ),
  );

  it.effect("lets the operator cancel a waiting Run or retry it now", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const provider = yield* scriptedProvider(minutes(600));
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const retried = yield* claimed(engine, submission({ number: 1, item: "item-1" }));
          const canceled = yield* claimed(engine, submission({ number: 2, item: "item-2" }));
          yield* settle(engine, [retried, canceled]);
          const before = (yield* Ref.get(provider.starts)).length;

          yield* TestClock.adjust(Duration.minutes(1));
          yield* engine.retry(
            retried,
            RetryRequest.make({ requestedBy: Option.none(), amendment: Option.none() }),
          );
          yield* engine.cancel(canceled);
          const [now, gone] = yield* settle(engine, [retried, canceled]);
          assert.strictEqual(gone?.run.state._tag, "Canceled");
          assert.strictEqual(now?.run.state._tag, "Running");
          assert.strictEqual(
            Option.getOrNull(now?.attempts.at(-1)?.start ?? Option.none())?._tag,
            "OperatorRetry",
          );
          const after = yield* Ref.get(provider.starts);
          assert.deepStrictEqual(
            after.slice(before).map(({ runId, at }) => [runId, at]),
            [[retried, minutes(1)]],
          );
          const [wait] = yield* engine.capacityWaits;
          assert.deepStrictEqual(wait?.runIds, [retried]);
          assert.strictEqual(wait?.refusals, 2);
          assert.strictEqual(
            DateTime.toEpochMillis(wait?.nextTryAt ?? DateTime.makeUnsafe(0)),
            minutes(16),
          );
        }).pipe(Effect.provide(engineLayer(directory, provider.executor)));
      }),
    ),
  );
});
