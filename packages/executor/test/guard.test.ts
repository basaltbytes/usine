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
import * as AttemptChannel from "@usine/core/attempt/channel";
import { DateTime, Deferred, Effect, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";
import { withAttemptGuard } from "../src/guard.ts";

const child = (id: string) =>
  new ChildSession({
    id: AgentSessionId.make(id),
    parentId: AgentSessionId.make("parent"),
    agent: AgentName.make("developer"),
    brain: new BrainSpec({ harness: "pi", model: ModelId.make("openai/model"), effort: "high" }),
  });
const first = child("first");
const second = child("second");
const setup = Effect.gen(function* () {
  const opened = yield* Deferred.make<AttemptChannel.Sink>();
  const result = yield* withAttemptGuard(
    { attemptId: AttemptId.make("guarded"), maxAttemptMinutes: 1, maxAttemptTokens: 100 },
    { append: () => Effect.void },
    (sink) => Deferred.succeed(opened, sink).pipe(Effect.andThen(Effect.never)),
  ).pipe(Effect.result, Effect.forkChild);
  const sink = yield* Deferred.await(opened);
  let sequence = 0;
  const emit = (payload: AttemptChannel.OutboundPayload) =>
    sink.append(
      "outbound",
      new AttemptChannel.OutboundEnvelope({
        version: AttemptChannel.PROTOCOL_VERSION,
        attemptId: AttemptId.make("guarded"),
        sequence: AttemptChannel.Sequence.make(++sequence),
        sentAt: DateTime.makeUnsafe("2026-09-12"),
        payload,
      }),
    );
  const hold = (session: ChildSession, held: boolean) =>
    emit(
      new AttemptChannel.InterventionApplied({
        inputSequence: AttemptChannel.Sequence.make(sequence + 1),
        intervention: new AttemptChannel.Intervention({
          operator: "Philippe",
          target: new AttemptChannel.ChildTarget({ sessionId: session.id }),
          action: held
            ? new AttemptChannel.OperatorMessage({ message: "Review this with me" })
            : new AttemptChannel.Release(),
        }),
        state: new AttemptChannel.InterventionState({ held, paused: false }),
      }),
    );
  return { result, emit, hold };
});

describe("Attempt guard", () => {
  it.effect(
    "preserves the remaining time across concurrent Holds and resumes when the last child ends",
    () =>
      Effect.gen(function* () {
        const { result, emit, hold } = yield* setup;
        yield* TestClock.adjust("20 seconds");
        yield* hold(first, true);
        yield* hold(second, true);
        yield* TestClock.adjust("2 hours");
        assert.strictEqual(result.pollUnsafe(), undefined);
        yield* hold(first, false);
        yield* TestClock.adjust("2 hours");
        assert.strictEqual(result.pollUnsafe(), undefined);
        yield* emit(
          new AttemptChannel.SessionEvent({ event: new SessionFinished({ session: second }) }),
        );
        // A late delivery receipt cannot reopen the Hold of a terminated child.
        yield* hold(second, true);
        yield* TestClock.adjust("39 seconds");
        assert.strictEqual(result.pollUnsafe(), undefined);
        yield* TestClock.adjust("1 second");
        const outcome = yield* Fiber.join(result);
        assert(Result.isFailure(outcome) && outcome.failure._tag === "RunawayFailure");
        assert.strictEqual(outcome.failure.ceiling, "wall-clock");
      }),
  );

  it.effect(
    "keeps the aggregate token ceiling armed during a Hold without double-counting cumulative meters",
    () =>
      Effect.gen(function* () {
        const { result, emit, hold } = yield* setup;
        yield* hold(first, true);
        const usage = (session: ChildSession, count: number) =>
          emit(
            new AttemptChannel.SessionEvent({
              event: new SessionTokensUpdated({ session, totalTokens: TokenCount.make(count) }),
            }),
          );
        yield* usage(first, 60);
        yield* usage(first, 60);
        yield* usage(first, 20);
        yield* usage(second, 39);
        yield* TestClock.adjust("2 hours");
        assert.strictEqual(result.pollUnsafe(), undefined);
        yield* usage(second, 40).pipe(Effect.forkChild);
        const outcome = yield* Fiber.join(result);
        assert(Result.isFailure(outcome) && outcome.failure._tag === "RunawayFailure");
        assert.strictEqual(outcome.failure.ceiling, "tokens");
      }),
  );
});
