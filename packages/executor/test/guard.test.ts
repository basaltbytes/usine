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
import { aloneOnItem } from "./exe-dev/support.ts";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AgentFailure, type AttemptFailure } from "@usine/core/attempt/failure";
import { DateTime, Deferred, Effect, Fiber, Option, Queue, Result } from "effect";
import { TestClock } from "effect/testing";
import { type AttemptGuardLimits, attemptGuard } from "../src/guard.ts";

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

const setup = (
  ceilings: Pick<AttemptGuardLimits, "maxAttemptMinutes" | "maxAttemptTokens">,
  warnFails = false,
) =>
  Effect.gen(function* () {
    const warnings: Array<string> = [];
    const finished = yield* Deferred.make<void>();
    const inputs = yield* Queue.make<{
      readonly envelope: AttemptChannel.OutboundEnvelope;
      readonly written: Deferred.Deferred<void, AttemptFailure>;
    }>();
    const guard = yield* attemptGuard(
      {
        attemptId,
        ...ceilings,
        warn: (message) =>
          Effect.sync(() => {
            warnings.push(message);
          }).pipe(
            Effect.andThen(
              warnFails ? new AgentFailure({ message: "no live channel" }) : Effect.void,
            ),
          ),
      },
      {
        append: () => Effect.void,
        salvage: () => Effect.void,
        comments: () => Effect.void,
        transcript: Effect.succeed([]),
        windows: aloneOnItem(attemptId),
      },
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
            sentAt: DateTime.makeUnsafe("2026-09-12"),
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
    return { result, emit, hold, usage, warnings, finished };
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
          true,
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
});
