import type { AttemptId } from "@usine/core/attempt";
import type { AgentSession, AgentSessionId } from "@usine/core/agent/session";
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

/** Holds by session: the parent, which operator input addresses without an id, or a child by its id. */
const holdKey = (session: AttemptChannel.SessionTarget | AgentSession): string => {
  switch (session._tag) {
    case "Parent":
    case "ParentSession":
      return "parent";
    case "Child":
      return session.sessionId;
    case "ChildSession":
      return session.id;
  }
};

/**
 * Counts unsupervised milliseconds: `observe` tracks which sessions are held,
 * the parent included, and `watch` warns at the ceiling's warning point, then
 * trips at its limit.
 */
const wallClockWatcher = Effect.fn("AttemptGuard.wallClockWatcher")(function* (
  attemptId: AttemptId,
  wallClock: Ceiling,
  warn: Warn,
) {
  const ended = new Set<string>();
  const holds = new Set<string>();
  const changes = yield* Queue.make<boolean>();
  const observe: Observer = (envelope) =>
    Effect.gen(function* () {
      const wasHeld = holds.size > 0;
      const payload = envelope.payload;
      if (payload._tag === "InterventionApplied") {
        const key = holdKey(payload.intervention.target);
        if (payload.state.held && !ended.has(key)) holds.add(key);
        else holds.delete(key);
      }
      if (payload._tag === "SessionEvent" && payload.event._tag === "SessionFinished") {
        const key = holdKey(payload.event.session);
        ended.add(key);
        holds.delete(key);
      }
      const isHeld = holds.size > 0;
      if (wasHeld !== isHeld) {
        yield* Effect.logInfo("Attempt wall-clock supervision changed", {
          attemptId,
          heldSessions: holds.size,
          parentHeld: holds.has("parent"),
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

/** One Attempt under its ceilings: the sink that meters it and the watch of its unsupervised time. */
export interface AttemptGuard {
  /** Appends through to the Attempt's sink; the append that reaches the token ceiling fails with `RunawayFailure`. */
  readonly sink: AttemptChannel.Sink;
  /** Fails with `RunawayFailure` when the wall-clock ceiling trips; never ends while that ceiling is unarmed. */
  readonly tripped: Effect.Effect<never, RunawayFailure>;
}

/**
 * Arms the Attempt ceilings that are configured: Holds pause elapsed
 * execution time; reported tokens continue accumulating. Each armed ceiling
 * sends the parent one warning steer at `WARNING_FRACTION` of its limit.
 * With no ceiling armed the Attempt runs on the channel untouched.
 */
export const attemptGuard = (
  limits: AttemptGuardLimits,
  io: AttemptChannel.Sink,
): Effect.Effect<AttemptGuard> => {
  const wallClock = Option.map(limits.maxAttemptMinutes, (minutes) => ceiling(minutes * 60_000));
  const tokens = Option.map(limits.maxAttemptTokens, ceiling);
  if (Option.isNone(wallClock) && Option.isNone(tokens)) {
    return Effect.succeed({ sink: io, tripped: Effect.never });
  }
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
      comments: io.comments,
      overlapping: io.overlapping,
    };
    return {
      sink,
      tripped: Option.match(clock, { onNone: () => Effect.never, onSome: ({ watch }) => watch }),
    };
  });
};
