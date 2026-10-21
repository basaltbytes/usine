import { assert, describe, it } from "@effect/vitest";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  ChildSession,
  SessionFinished,
  SessionTokensUpdated,
  TokenCount,
} from "@usine/core/agent/session";
import { AttemptId } from "@usine/core/attempt";
import { recording } from "./exe-dev/support.ts";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AgentFailure, type AttemptFailure } from "@usine/core/attempt/failure";
import { DateTime, Deferred, Effect, Fiber, Option, Queue, Result } from "effect";
import { TestClock } from "effect/testing";
import {
  type AttemptGuardLimits,
  type AttemptGuardSeed,
  attemptGuard,
  guardSeed,
} from "../src/guard.ts";

const child = (id: string) =>
  new ChildSession({
    id: AgentSessionId.make(id),
    parentId: AgentSessionId.make("parent"),
    agent: AgentName.make("developer"),
    brain: new BrainSpec({ harness: "pi", model: ModelId.make("openai/model"), effort: "high" }),
  });
const first = child("first");
const second = child("second");
const attemptId = AttemptId.make("guarded");

/**
 * Arms a guard over a sink that records every envelope, as the transcript
 * does, and runs it until a ceiling trips. Each warning is recorded as the
 * steer the durable runtime appends for it. `seed` resumes a guard from what
 * an earlier one recorded, as a reattachment after a restart does.
 */
const setup = (
  ceilings: Pick<AttemptGuardLimits, "maxAttemptMinutes" | "maxAttemptTokens">,
  options: {
    readonly warnFails?: boolean;
    readonly seed?: AttemptGuardSeed;
  } = {},
) =>
  Effect.gen(function* () {
    const warnings: Array<string> = [];
    const { sink: io } = recording();
    const finished = yield* Deferred.make<void>();
    const inputs = yield* Queue.make<{
      readonly envelope: AttemptChannel.OutboundEnvelope;
      readonly written: Deferred.Deferred<void, AttemptFailure>;
    }>();
    let inbound = 0;
    const guard = yield* attemptGuard(
      {
        attemptId,
        ...ceilings,
        warn: (message) =>
          Effect.gen(function* () {
            warnings.push(message);
            yield* io.append(
              "inbound",
              new AttemptChannel.InboundEnvelope({
                version: AttemptChannel.PROTOCOL_VERSION,
                attemptId,
                sequence: AttemptChannel.Sequence.make(++inbound),
                sentAt: yield* DateTime.now,
                target: new AttemptChannel.ParentTarget(),
                operator: "engine",
                payload: new AttemptChannel.Steer({ message }),
              }),
            );
            if (options.warnFails === true) {
              return yield* new AgentFailure({ message: "no live channel" });
            }
          }),
      },
      io,
      options.seed ?? guardSeed([]),
    );
    const attempt = Effect.raceFirst(
      Effect.forever(
        Effect.gen(function* () {
          const { envelope, written } = yield* Queue.take(inputs);
          yield* guard.sink
            .append("outbound", envelope)
            .pipe(Effect.onExit((exit) => Deferred.done(written, exit)));
        }),
      ),
      Deferred.await(finished).pipe(Effect.as("finished" as const)),
    );
    const result = yield* Effect.raceFirst(attempt, guard.tripped).pipe(
      Effect.result,
      Effect.forkChild,
    );
    let sequence = 0;
    const emit = (payload: AttemptChannel.OutboundPayload) =>
      Effect.gen(function* () {
        const written = yield* Deferred.make<void, AttemptFailure>();
        yield* Queue.offer(inputs, {
          written,
          envelope: new AttemptChannel.OutboundEnvelope({
            version: AttemptChannel.PROTOCOL_VERSION,
            attemptId,
            sequence: AttemptChannel.Sequence.make(++sequence),
            sentAt: yield* DateTime.now,
            payload,
          }),
        });
        yield* Deferred.await(written);
      });
    const hold = (session: ChildSession | "parent", held: boolean) =>
      emit(
        new AttemptChannel.InterventionApplied({
          inputSequence: AttemptChannel.Sequence.make(sequence + 1),
          intervention: new AttemptChannel.Intervention({
            operator: "Philippe",
            target:
              session === "parent"
                ? new AttemptChannel.ParentTarget()
                : new AttemptChannel.ChildTarget({ sessionId: session.id }),
            action: held
              ? new AttemptChannel.OperatorMessage({ message: "Review this with me" })
              : new AttemptChannel.Release(),
          }),
          state: new AttemptChannel.InterventionState({ held, paused: false }),
        }),
      );
    const usage = (session: ChildSession, count: number) =>
      emit(
        new AttemptChannel.SessionEvent({
          event: new SessionTokensUpdated({ session, totalTokens: TokenCount.make(count) }),
        }),
      );
    const started = emit(
      new AttemptChannel.Started({ parentModel: ModelId.make("openai/parent") }),
    );
    /** Stops this guard as an orchestrator restart does, and gives the seed its transcript leaves. */
    const restart = Fiber.interrupt(result).pipe(
      Effect.andThen(io.transcript),
      Effect.map(guardSeed),
    );
    return { result, emit, hold, usage, started, restart, warnings, finished };
  });

describe("Attempt guard", () => {
  it.effect(
    "preserves the remaining time across concurrent Holds, the parent's included, warns once at 80% of unsupervised time, and trips at the end",
    () =>
      Effect.gen(function* () {
        const { result, emit, hold, warnings } = yield* setup({
          maxAttemptMinutes: Option.some(1),
          maxAttemptTokens: Option.some(100),
        });
        yield* TestClock.adjust("20 seconds");
        yield* hold(first, true);
        yield* hold(second, true);
        yield* TestClock.adjust("2 hours");
        assert.strictEqual(result.pollUnsafe(), undefined);
        yield* hold(first, false);
        yield* TestClock.adjust("2 hours");
        assert.strictEqual(result.pollUnsafe(), undefined);
        assert.deepStrictEqual(warnings, []);
        // A parent waiting for the operator under its Hold is supervised too.
        yield* hold("parent", true);
        yield* emit(
          new AttemptChannel.SessionEvent({ event: new SessionFinished({ session: second }) }),
        );
        yield* TestClock.adjust("2 hours");
        assert.strictEqual(result.pollUnsafe(), undefined);
        assert.deepStrictEqual(warnings, []);
        yield* hold("parent", false);
        // A late delivery receipt cannot reopen the Hold of a terminated child.
        yield* hold(second, true);
        yield* TestClock.adjust("39 seconds");
        assert.strictEqual(result.pollUnsafe(), undefined);
        assert.deepStrictEqual(warnings, [
          "0.8 of 1 minutes used by this Attempt; commit and push your work now.",
        ]);
        yield* TestClock.adjust("1 second");
        const outcome = yield* Fiber.join(result);
        assert(Result.isFailure(outcome) && outcome.failure._tag === "RunawayFailure");
        assert.strictEqual(outcome.failure.ceiling, "wall-clock");
        assert.strictEqual(warnings.length, 1);
      }),
  );

  it.effect(
    "keeps the aggregate token ceiling armed during a Hold, warns once at 80%, and survives an undeliverable warning",
    () =>
      Effect.gen(function* () {
        const { result, hold, usage, warnings } = yield* setup(
          { maxAttemptMinutes: Option.some(1), maxAttemptTokens: Option.some(100) },
          { warnFails: true },
        );
        yield* hold(first, true);
        yield* usage(first, 60);
        yield* usage(first, 60);
        yield* usage(first, 20);
        assert.deepStrictEqual(warnings, []);
        yield* usage(second, 25);
        assert.deepStrictEqual(warnings, [
          "85 of 100 tokens used by this Attempt; commit and push your work now.",
        ]);
        yield* usage(first, 70);
        yield* TestClock.adjust("2 hours");
        assert.strictEqual(result.pollUnsafe(), undefined);
        assert.strictEqual(warnings.length, 1);
        const rejected = yield* usage(second, 40).pipe(Effect.result);
        assert(Result.isFailure(rejected) && rejected.failure._tag === "RunawayFailure");
        const outcome = yield* Fiber.join(result);
        assert(Result.isFailure(outcome) && outcome.failure._tag === "RunawayFailure");
        assert.strictEqual(outcome.failure.ceiling, "tokens");
      }),
  );

  it.effect("arms nothing when no ceiling is configured", () =>
    Effect.gen(function* () {
      const { result, usage, warnings, finished } = yield* setup({
        maxAttemptMinutes: Option.none(),
        maxAttemptTokens: Option.none(),
      });
      yield* usage(first, 12_000_000);
      yield* TestClock.adjust("3 hours");
      yield* usage(second, 30_000_000);
      assert.strictEqual(result.pollUnsafe(), undefined);
      assert.deepStrictEqual(warnings, []);
      yield* Deferred.succeed(finished, undefined);
      const outcome = yield* Fiber.join(result);
      assert(Result.isSuccess(outcome) && outcome.success === "finished");
    }),
  );

  it.effect(
    "trips a reattached Attempt after 70% of its time at 100% of the original, keeping the parent's Hold across the restart",
    () =>
      Effect.gen(function* () {
        const ceilings = { maxAttemptMinutes: Option.some(1), maxAttemptTokens: Option.none() };
        const before = yield* setup(ceilings);
        yield* before.started;
        yield* TestClock.adjust("30 seconds");
        yield* before.hold("parent", true);
        yield* TestClock.adjust("2 hours");
        yield* before.hold("parent", false);
        yield* TestClock.adjust("12 seconds");
        // 42 of the 60 unsupervised seconds are spent when the operator holds the parent again.
        yield* before.hold("parent", true);
        const seed = yield* before.restart;
        // Nothing runs the Attempt while the orchestrator is down.
        yield* TestClock.adjust("10 minutes");
        const after = yield* setup(ceilings, { seed });
        yield* TestClock.adjust("1 hour");
        assert.strictEqual(after.result.pollUnsafe(), undefined, "the Hold outlives the restart");
        yield* after.hold("parent", false);
        yield* TestClock.adjust("6 seconds");
        assert.deepStrictEqual(after.warnings, [
          "0.8 of 1 minutes used by this Attempt; commit and push your work now.",
        ]);
        yield* TestClock.adjust("11 seconds");
        assert.strictEqual(after.result.pollUnsafe(), undefined);
        yield* TestClock.adjust("1 second");
        const outcome = yield* Fiber.join(after.result);
        assert(Result.isFailure(outcome) && outcome.failure._tag === "RunawayFailure");
        assert.strictEqual(outcome.failure.ceiling, "wall-clock");
        assert.deepStrictEqual([...before.warnings, ...after.warnings].length, 1);
      }),
  );

  it.effect("counts the tokens of a session that finished before the restart", () =>
    Effect.gen(function* () {
      const ceilings = { maxAttemptMinutes: Option.none(), maxAttemptTokens: Option.some(100) };
      const before = yield* setup(ceilings);
      yield* before.started;
      yield* before.usage(first, 60);
      yield* before.emit(
        new AttemptChannel.SessionEvent({ event: new SessionFinished({ session: first }) }),
      );
      const after = yield* setup(ceilings, { seed: yield* before.restart });
      yield* after.usage(second, 30);
      assert.deepStrictEqual(after.warnings, [
        "90 of 100 tokens used by this Attempt; commit and push your work now.",
      ]);
      const rejected = yield* after.usage(second, 40).pipe(Effect.result);
      assert(Result.isFailure(rejected) && rejected.failure._tag === "RunawayFailure");
      assert.strictEqual(rejected.failure.ceiling, "tokens");
    }),
  );

  it.effect("sends each ceiling's warning once across a restart", () =>
    Effect.gen(function* () {
      const ceilings = { maxAttemptMinutes: Option.some(1), maxAttemptTokens: Option.some(100) };
      const before = yield* setup(ceilings);
      yield* before.started;
      yield* TestClock.adjust("50 seconds");
      yield* before.usage(first, 85);
      assert.deepStrictEqual(before.warnings, [
        "0.8 of 1 minutes used by this Attempt; commit and push your work now.",
        "85 of 100 tokens used by this Attempt; commit and push your work now.",
      ]);
      const after = yield* setup(ceilings, { seed: yield* before.restart });
      yield* after.usage(second, 5);
      yield* TestClock.adjust("9 seconds");
      assert.strictEqual(after.result.pollUnsafe(), undefined);
      assert.deepStrictEqual(after.warnings, []);
      yield* TestClock.adjust("1 second");
      const outcome = yield* Fiber.join(after.result);
      assert(Result.isFailure(outcome) && outcome.failure._tag === "RunawayFailure");
      assert.strictEqual(outcome.failure.ceiling, "wall-clock");
      assert.deepStrictEqual(after.warnings, []);
    }),
  );
});
