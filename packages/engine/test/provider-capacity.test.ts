import { assert, describe, it } from "@effect/vitest";
import { Agent, AgentName } from "@usine/core/agent";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { ProviderCapacityFailure } from "@usine/core/attempt/failure";
import {
  type AgentSessionEvent,
  AgentSessionId,
  ChildSession,
  ParentSession,
  ProviderAnswered,
  TextOutput,
} from "@usine/core/agent/session";
import type { RunId } from "@usine/core/run";
import { StepCompletion } from "@usine/core/step/result";
import { WorkerName } from "@usine/core/worker";
import {
  Array as EffectArray,
  Context,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Scope,
} from "effect";
import { TestClock } from "effect/testing";
import { RetryRequest, RunEngine, Submission } from "../src/engine/engine.ts";
import { type StepExecution, StepExecutor } from "../src/step-executor.ts";
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
  readonly worker: string;
  readonly at: number;
}

/** How the scripted provider runs an Attempt that it accepts. */
interface Accepted {
  /** Whether the Attempt's child reports the provider's `ProviderAnswered` first. */
  readonly answers: boolean;
  /** Accepted Attempts wait for these in turn; the last one holds every later Attempt. */
  readonly holds: ReadonlyArray<Deferred.Deferred<void>>;
}

const immediately: Accepted = { answers: false, holds: [] };

/** Returns an outbound transcript envelope of `event` from a session of `execution`'s Attempt. */
const sessionEnvelope = (
  execution: StepExecution,
  sequence: number,
  at: number,
  event: (session: {
    readonly parent: ParentSession;
    readonly child: ChildSession;
  }) => AgentSessionEvent,
) => {
  const { attempt } = execution;
  const parent = ParentSession.make({
    id: AgentSessionId.make(`${attempt.id}/parent`),
    agent: attempt.agent,
    brain: attempt.brain,
  });
  const child = ChildSession.make({
    id: AgentSessionId.make(`${attempt.id}/child`),
    parentId: parent.id,
    agent: attempt.agent,
    brain: attempt.brain,
  });
  return AttemptChannel.OutboundEnvelope.make({
    version: AttemptChannel.PROTOCOL_VERSION,
    attemptId: attempt.id,
    sequence: AttemptChannel.Sequence.make(sequence),
    sentAt: DateTime.makeUnsafe(at),
    payload: AttemptChannel.SessionEvent.make({ event: event({ parent, child }) }),
  });
};

/**
 * A provider that refuses Claude requests until `limitEndsAt`, in milliseconds since the epoch of
 * the test clock, without a reset time unless `resetsAt` is set. Codex requests always succeed. A
 * refused Attempt first reports Claude Code's synthetic usage-limit answer from its child and a
 * parent model answer, neither of which is the provider of the child accepting a request. Each
 * reserved slot is on the next of `workers` in turn.
 */
const scriptedProvider = (
  limitEndsAt: number,
  accepted: Accepted = immediately,
  resetsAt: Option.Option<number> = Option.none(),
  workers: EffectArray.NonEmptyReadonlyArray<string> = ["local"],
) =>
  Effect.gen(function* () {
    const starts = yield* Ref.make<ReadonlyArray<Started>>([]);
    const leased = yield* Ref.make(0);
    const reserved = yield* Ref.make(0);
    const acceptedCount = yield* Ref.make(0);
    const names = EffectArray.map(workers, (name) => WorkerName.make(name));
    const executor = Layer.succeed(StepExecutor)({
      workers: Effect.succeed(names),
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
          Effect.andThen(
            Ref.modify(reserved, (count) => [names[count % names.length] ?? names[0], count + 1]),
          ),
          Effect.map((worker) => ({
            worker,
            kind: "local" as const,
            release: Ref.update(leased, (count) => count - 1),
          })),
        ),
      execute: (execution, io) =>
        Effect.gen(function* () {
          const at = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
          const { harness } = execution.attempt.brain;
          const { worker } = execution.attempt;
          yield* Ref.update(starts, (seen) => [
            ...seen,
            { runId: execution.run.id, harness, worker, at },
          ]);
          if (harness === "claude" && at < limitEndsAt) {
            yield* io.append(
              "outbound",
              sessionEnvelope(execution, 1, at, ({ parent }) =>
                ProviderAnswered.make({ session: parent }),
              ),
            );
            yield* io.append(
              "outbound",
              sessionEnvelope(execution, 2, at, ({ child }) =>
                TextOutput.make({
                  session: child,
                  text: "You've hit your limit · resets 5am (UTC)",
                }),
              ),
            );
            return yield* ProviderCapacityFailure.make({
              message: refusal,
              resetsAt: Option.map(resetsAt, (millis) => DateTime.makeUnsafe(millis)),
            });
          }
          if (accepted.answers)
            yield* io.append(
              "outbound",
              sessionEnvelope(execution, 1, at, ({ child }) =>
                ProviderAnswered.make({ session: child }),
              ),
            );
          const index = yield* Ref.getAndUpdate(acceptedCount, (count) => count + 1);
          const hold = accepted.holds[Math.min(index, accepted.holds.length - 1)];
          if (hold !== undefined) yield* Deferred.await(hold);
          return StepCompletion.fromResult(stepResult("done"));
        }),
    });
    return { starts, leased, executor };
  });

/** Returns the Runs of `runIds` whose latest Attempt is still open. */
const openRuns = (engine: RunEngine["Service"], runIds: ReadonlyArray<RunId>) =>
  Effect.forEach(runIds, (runId) => engine.inspect(runId)).pipe(
    Effect.map((snapshots) =>
      snapshots.flatMap(({ run, attempts }) => {
        const last = attempts.at(-1);
        return last !== undefined && Option.isNone(last.outcome) ? [run.id] : [];
      }),
    ),
  );

/** Yields until `count` Runs of `runIds` have an open Attempt, and returns them. */
const awaitOpen = (engine: RunEngine["Service"], runIds: ReadonlyArray<RunId>, count: number) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 500; tries += 1) {
      const open = yield* openRuns(engine, runIds);
      if (open.length >= count) return open;
      yield* Effect.yieldNow;
    }
    return yield* openRuns(engine, runIds);
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
    "keeps the Runs through a two-hour limit and tests the group once per backoff step",
    () =>
      withInstance((directory) =>
        Effect.gen(function* () {
          const provider = yield* scriptedProvider(minutes(120));
          yield* Effect.gen(function* () {
            const engine = yield* RunEngine;
            const first = yield* Effect.forEach([1, 2, 3], (number) =>
              claimed(engine, submission({ number, item: `item-${number}` })),
            );
            yield* settle(engine, first);
            const initial = (yield* Ref.get(provider.starts)).filter(
              ({ harness }) => harness === "claude",
            );
            assert.isAtMost(initial.length, 3);

            // While Claude refuses, a Codex Run on the same Worker runs, and a new Claude Run
            // waits without an Attempt.
            const codex = yield* claimed(
              engine,
              Submission.make({ ...submission({ number: 4, item: "item-4" }), agent: codexAgent }),
            );
            const [other] = yield* settle(engine, [codex], (state) => state === "Succeeded");
            assert.strictEqual(other?.run.state._tag, "Succeeded");
            const late = yield* claimed(engine, submission({ number: 5, item: "item-5" }));
            const claude = [...first, late];
            yield* settle(engine, claude);
            const beforeLate = (yield* Ref.get(provider.starts)).filter(
              ({ harness }) => harness === "claude",
            );
            assert.strictEqual(beforeLate.length, initial.length);
            const waits = yield* engine.capacityWaits;
            assert.include(waits[0]?.runIds ?? [], late);
            assert.strictEqual(waits.length, 1);
            assert.strictEqual(waits[0]?.message, refusal);
            assert.strictEqual(
              DateTime.toEpochMillis(waits[0]?.nextTryAt ?? DateTime.makeUnsafe(0)),
              minutes(5),
            );
            const waitingLeases = yield* Ref.get(provider.leased);
            assert.strictEqual(waitingLeases, 0);

            // Stops a minute before and at each expected test of the group, then past the limit.
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
            // One Attempt tests the group at 5, 20, 50, and 110 minutes; the one at 170 minutes,
            // within one 60-minute step of the limit's end, succeeds and releases the others.
            assert.deepStrictEqual(later, [
              minutes(5),
              minutes(20),
              minutes(50),
              minutes(110),
              minutes(170),
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
    "backs off in the group of each refusal when a Run's Attempts alternate between Workers",
    () =>
      withInstance((directory) =>
        Effect.gen(function* () {
          const provider = yield* scriptedProvider(minutes(120), immediately, Option.none(), [
            "local",
            "remote",
          ]);
          yield* Effect.gen(function* () {
            const engine = yield* RunEngine;
            const runId = yield* claimed(engine, submission({ number: 1 }));
            yield* settle(engine, [runId]);
            let elapsed = 0;
            for (const checkpoint of [4, 5, 9, 10, 24, 25, 39, 40, 69, 70, 99, 100, 159, 160]) {
              yield* TestClock.adjust(Duration.minutes(checkpoint - elapsed));
              elapsed = checkpoint;
              yield* settle(engine, [runId]);
            }
            // Each Worker's group backs off after its own refusals: 5, 15, 30, then 60 minutes.
            const starts = yield* Ref.get(provider.starts);
            assert.deepStrictEqual(
              starts.map(({ worker, at }) => [worker, at / minutes(1)]),
              [
                ["local", 0],
                ["remote", 5],
                ["local", 10],
                ["remote", 25],
                ["local", 40],
                ["remote", 70],
                ["local", 100],
                ["remote", 160],
              ],
            );
            const [done] = yield* settle(engine, [runId], (state) => state === "Succeeded");
            assert.strictEqual(done?.run.state._tag, "Succeeded");
          }).pipe(Effect.provide(engineLayer(directory, provider.executor)));
        }),
      ),
    { timeout: 120_000 },
  );

  it.effect("rebuilds the group's backoff from a waiting Run's refusals after a restart", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const provider = yield* scriptedProvider(minutes(600));
        const scope = yield* Scope.make();
        const services = yield* Scope.provide(
          Layer.build(engineLayer(directory, provider.executor)),
          scope,
        );
        const before = Context.get(services, RunEngine);
        const runId = yield* claimed(before, submission({ number: 1 }));
        yield* settle(before, [runId]);
        let elapsed = 0;
        for (const checkpoint of [5, 20, 50]) {
          yield* TestClock.adjust(Duration.minutes(checkpoint - elapsed));
          elapsed = checkpoint;
          yield* settle(before, [runId]);
        }
        const refused = yield* Ref.get(provider.starts);
        assert.lengthOf(refused, 4);
        yield* Scope.close(scope, Exit.void);

        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          yield* settle(engine, [runId]);
          // Four refusals, each from an Attempt that started after the previous one ended.
          const [wait] = yield* engine.capacityWaits;
          assert.strictEqual(wait?.refusals, 4);
          assert.strictEqual(
            DateTime.toEpochMillis(wait?.nextTryAt ?? DateTime.makeUnsafe(0)),
            minutes(110),
          );
          yield* TestClock.adjust(Duration.minutes(59));
          yield* settle(engine, [runId]);
          const waited = yield* Ref.get(provider.starts);
          assert.lengthOf(waited, 4);
          yield* TestClock.adjust(Duration.minutes(1));
          yield* settle(engine, [runId]);
          const tested = yield* Ref.get(provider.starts);
          assert.lengthOf(tested, 5);
        }).pipe(Effect.provide(engineLayer(directory, provider.executor)));
      }),
    ),
  );

  it.effect(
    "releases the waiting Runs at the first answer of the Attempt that tests the group",
    () =>
      withInstance((directory) =>
        Effect.gen(function* () {
          const hold = yield* Deferred.make<void>();
          const provider = yield* scriptedProvider(minutes(10), { answers: true, holds: [hold] });
          yield* Effect.gen(function* () {
            const engine = yield* RunEngine;
            const runs = yield* Effect.forEach([1, 2], (number) =>
              claimed(engine, submission({ number, item: `item-${number}` })),
            );
            yield* settle(engine, runs);
            yield* TestClock.adjust(Duration.minutes(5));
            yield* settle(engine, runs);
            yield* TestClock.adjust(Duration.minutes(15));
            yield* awaitOpen(engine, runs, runs.length);
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

  it.effect(
    "releases the waiting Runs when the Attempt that tests the group succeeds without an answer",
    () =>
      withInstance((directory) =>
        Effect.gen(function* () {
          const probe = yield* Deferred.make<void>();
          const rest = yield* Deferred.make<void>();
          // A worker image that predates `ProviderAnswered` reports no answer.
          const provider = yield* scriptedProvider(minutes(10), {
            answers: false,
            holds: [probe, rest],
          });
          yield* Effect.gen(function* () {
            const engine = yield* RunEngine;
            const runs = yield* Effect.forEach([1, 2, 3], (number) =>
              claimed(engine, submission({ number, item: `item-${number}` })),
            );
            yield* settle(engine, runs);
            yield* TestClock.adjust(Duration.minutes(5));
            yield* settle(engine, runs);
            yield* TestClock.adjust(Duration.minutes(15));
            const testing = yield* awaitOpen(engine, runs, 1);
            const waiting = runs.filter((runId) => !testing.includes(runId));
            yield* settle(engine, waiting);
            const alone = yield* openRuns(engine, runs);
            assert.deepStrictEqual(alone, testing);
            yield* Deferred.succeed(probe, undefined);
            // Both other Runs start together; one at a time would mean each tests the group.
            const others = yield* awaitOpen(engine, waiting, 2);
            assert.sameMembers([...others], waiting);
            yield* Deferred.succeed(rest, undefined);
            const done = yield* settle(engine, runs, (state) => state === "Succeeded");
            assert.lengthOf(done, 3);
          }).pipe(Effect.provide(engineLayer(directory, provider.executor)));
        }),
      ),
  );

  it.effect("waits until a reported reset time", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const provider = yield* scriptedProvider(
          minutes(180),
          immediately,
          Option.some(minutes(180)),
        );
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
          // A Run submitted while its group is at capacity waits without an Attempt.
          const unstarted = yield* claimed(engine, submission({ number: 3, item: "item-3" }));
          const [pending] = yield* settle(engine, [unstarted]);
          assert.strictEqual(pending?.run.state._tag, "Pending");
          assert.lengthOf(pending?.attempts ?? [], 0);
          const before = (yield* Ref.get(provider.starts)).length;

          yield* TestClock.adjust(Duration.minutes(1));
          for (const runId of [retried, unstarted])
            yield* engine.retry(
              runId,
              RetryRequest.make({ requestedBy: Option.none(), amendment: Option.none() }),
            );
          yield* engine.cancel(canceled);
          const [now, gone, started] = yield* settle(engine, [retried, canceled, unstarted]);
          assert.strictEqual(gone?.run.state._tag, "Canceled");
          for (const snapshot of [now, started]) {
            assert.strictEqual(snapshot?.run.state._tag, "Running");
            assert.strictEqual(
              Option.getOrNull(snapshot?.attempts.at(-1)?.start ?? Option.none())?._tag,
              "OperatorRetry",
            );
          }
          const after = yield* Ref.get(provider.starts);
          assert.sameDeepMembers(
            after.slice(before).map(({ runId, at }) => [runId, at]),
            [
              [retried, minutes(1)],
              [unstarted, minutes(1)],
            ],
          );
          const [wait] = yield* engine.capacityWaits;
          assert.sameMembers([...(wait?.runIds ?? [])], [retried, unstarted]);
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
