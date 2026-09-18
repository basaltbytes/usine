import type { AttemptId } from "@usine/core/attempt";
import { AgentSessionId } from "@usine/core/agent/session";
import type * as AttemptChannel from "@usine/core/attempt/channel";
import { AttemptFailure, RunawayFailure } from "@usine/core/attempt/failure";
import { Clock, Effect, Option, Queue } from "effect";

/** The share of a ceiling at which the guard warns the parent session once, before tripping. */
const WARNING_FRACTION = 0.8;

export interface AttemptGuardLimits {
  readonly attemptId: AttemptId;
  /** Wall-clock ceiling in minutes; none leaves the timer unarmed. */
  readonly maxAttemptMinutes: Option.Option<number>;
  /** Consumed-token ceiling across the parent and every child; none leaves the meter unchecked. */
  readonly maxAttemptTokens: Option.Option<number>;
  /** Delivers the warning steer to the parent session; failures are logged and never fail the Attempt. */
  readonly warn: (message: string) => Effect.Effect<void, AttemptFailure>;
}

/** One armed ceiling: the limit that trips the guard and the point at which it warns first. */
interface Ceiling {
  readonly limit: number;
  readonly warnAt: number;
}

const ceiling = (limit: number): Ceiling => ({ limit, warnAt: limit * WARNING_FRACTION });

type Warn = (ceiling: "tokens" | "wall-clock", message: string) => Effect.Effect<void>;
type Observer = (envelope: AttemptChannel.Envelope) => Effect.Effect<void, RunawayFailure>;

/** Sums the highest reported count per session; tokens keep accumulating through Holds. */
const tokenWatcher = (attemptId: AttemptId, tokens: Ceiling, warn: Warn): Observer => {
  const reported = new Map<AgentSessionId, number>();
  let warned = false;
  return (envelope) =>
    Effect.gen(function* () {
      const payload = envelope.payload;
      if (payload._tag !== "SessionEvent" || payload.event._tag !== "SessionTokensUpdated") return;
      const { session, totalTokens } = payload.event;
      reported.set(session.id, Math.max(reported.get(session.id) ?? 0, totalTokens));
      const consumed = [...reported.values()].reduce((sum, value) => sum + value, 0);
      if (consumed >= tokens.limit) {
        yield* Effect.logWarning("Attempt reached its token limit", {
          attemptId,
          consumed,
          maxAttemptTokens: tokens.limit,
        });
        return yield* new RunawayFailure({ ceiling: "tokens" });
      }
      if (!warned && consumed >= tokens.warnAt) {
        warned = true;
        yield* warn(
          "tokens",
          `${consumed} of ${tokens.limit} tokens used by this Attempt; commit and push your work now.`,
        );
      }
    });
};

/**
 * Counts unsupervised milliseconds: `observe` tracks which children are held,
 * and `watch` warns at the ceiling's warning point, then trips at its limit.
 */
const wallClockWatcher = Effect.fn("AttemptGuard.wallClockWatcher")(function* (
  attemptId: AttemptId,
  wallClock: Ceiling,
  warn: Warn,
) {
  const ended = new Set<AgentSessionId>();
  const holds = new Set<AgentSessionId>();
  const changes = yield* Queue.make<boolean>();
  const observe: Observer = (envelope) =>
    Effect.gen(function* () {
      const wasHeld = holds.size > 0;
      const payload = envelope.payload;
      if (payload._tag === "InterventionApplied" && payload.intervention.target._tag === "Child") {
        const id = payload.intervention.target.sessionId;
        if (payload.state.held && !ended.has(id)) holds.add(id);
        else holds.delete(id);
      }
      if (payload._tag === "SessionEvent" && payload.event._tag === "SessionFinished") {
        ended.add(payload.event.session.id);
        holds.delete(payload.event.session.id);
      }
      const isHeld = holds.size > 0;
      if (wasHeld !== isHeld) {
        yield* Effect.logInfo("Attempt wall-clock supervision changed", {
          attemptId,
          heldChildren: holds.size,
        });
        yield* Queue.offer(changes, isHeld);
      }
    });
  const unsupervised = Effect.fn("AttemptGuard.unsupervised")(function* (milliseconds: number) {
    let remaining = milliseconds;
    let paused = false;
    while (remaining > 0) {
      if (paused) {
        paused = yield* Queue.take(changes);
        continue;
      }
      const began = yield* Clock.currentTimeMillis;
      const changed = yield* Queue.take(changes).pipe(Effect.timeoutOption(remaining));
      remaining -= (yield* Clock.currentTimeMillis) - began;
      if (Option.isSome(changed)) paused = changed.value;
    }
  });
  const watch = Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan({ attemptId });
    yield* unsupervised(wallClock.warnAt);
    yield* warn(
      "wall-clock",
      `${Math.round(wallClock.warnAt / 6_000) / 10} of ${wallClock.limit / 60_000} minutes used by this Attempt; commit and push your work now.`,
    );
    yield* unsupervised(wallClock.limit - wallClock.warnAt);
    yield* Effect.logWarning("Attempt reached its unsupervised wall-clock limit", {
      attemptId,
      maxAttemptMinutes: wallClock.limit / 60_000,
    });
    return yield* new RunawayFailure({ ceiling: "wall-clock" });
  }).pipe(Effect.withSpan("AttemptGuard.watch"));
  return { observe, watch };
});

/**
 * Enforces the Attempt ceilings that are configured: Holds pause elapsed
 * execution time; reported tokens continue accumulating. Each armed ceiling
 * sends the parent one warning steer at `WARNING_FRACTION` of its limit.
 * With no ceiling armed the Attempt runs on the channel untouched.
 */
export const withAttemptGuard = <A>(
  limits: AttemptGuardLimits,
  io: AttemptChannel.Sink,
  run: (sink: AttemptChannel.Sink) => Effect.Effect<A, AttemptFailure>,
): Effect.Effect<A, AttemptFailure> => {
  const wallClock = Option.map(limits.maxAttemptMinutes, (minutes) => ceiling(minutes * 60_000));
  const tokens = Option.map(limits.maxAttemptTokens, ceiling);
  if (Option.isNone(wallClock) && Option.isNone(tokens)) return run(io);
  return Effect.gen(function* () {
    const warn: Warn = (ceiling, message) =>
      Effect.logInfo("Warning the Attempt before its ceiling", {
        attemptId: limits.attemptId,
        ceiling,
      }).pipe(
        Effect.andThen(limits.warn(message)),
        Effect.tapError((error) =>
          Effect.logWarning("Attempt ceiling warning was not delivered", {
            attemptId: limits.attemptId,
            ceiling,
            errorTag: error._tag,
          }),
        ),
        Effect.ignore,
      );
    const observeTokens = Option.map(tokens, (tokens) =>
      tokenWatcher(limits.attemptId, tokens, warn),
    );
    const clock = yield* Effect.transposeOption(
      Option.map(wallClock, (wallClock) => wallClockWatcher(limits.attemptId, wallClock, warn)),
    );
    const sink: AttemptChannel.Sink = {
      append: Effect.fn("AttemptGuard.append")(function* (direction, envelope) {
        yield* Effect.annotateCurrentSpan({ attemptId: limits.attemptId });
        yield* io.append(direction, envelope);
        if (Option.isSome(observeTokens)) yield* observeTokens.value(envelope);
        if (Option.isSome(clock)) yield* clock.value.observe(envelope);
      }),
      salvage: io.salvage,
    };
    return yield* Option.match(clock, {
      onNone: () => run(sink),
      onSome: ({ watch }) => Effect.raceFirst(run(sink), watch),
    });
  });
};
