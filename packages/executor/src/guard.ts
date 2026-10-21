import type { AttemptId } from "@usine/core/attempt";
import type { AgentSession, AgentSessionId } from "@usine/core/agent/session";
import type * as AttemptChannel from "@usine/core/attempt/channel";
import { AttemptFailure, RunawayCeiling, RunawayFailure } from "@usine/core/attempt/failure";
import { Clock, DateTime, Duration, Effect, Option, Queue } from "effect";

/** The share of a ceiling at which the guard warns the parent session once, before tripping. */
const WARNING_FRACTION = 0.8;

/** The words every warning steer ends with, after the unit its ceiling counts in. */
const WARNING_ENDING = "used by this Attempt; commit and push your work now.";

/** The unit each ceiling's warning counts in. */
const WARNING_UNITS = {
  tokens: "tokens",
  "wall-clock": "minutes",
} as const satisfies Record<RunawayCeiling, string>;

const warning = (ceiling: RunawayCeiling, used: number, limit: number): string =>
  `${used} of ${limit} ${WARNING_UNITS[ceiling]} ${WARNING_ENDING}`;

export interface AttemptGuardLimits {
  readonly attemptId: AttemptId;
  /** Wall-clock ceiling in minutes; none leaves the timer unarmed. */
  readonly maxAttemptMinutes: Option.Option<number>;
  /** Consumed-token ceiling across the parent and every child; none leaves the meter unchecked. */
  readonly maxAttemptTokens: Option.Option<number>;
  /** Delivers the warning steer to the parent session; failures are logged and never fail the Attempt. */
  readonly warn: (message: string) => Effect.Effect<void, AttemptFailure>;
}

/**
 * What an Attempt's transcript recorded so far, which its guard goes on from:
 * a reattached Attempt's guard resumes where the guard before the orchestrator
 * restart stopped instead of starting over (#178), and a fresh Attempt's
 * empty transcript gives the guard nothing to resume.
 */
export interface AttemptGuardSeed {
  /** The highest token count each session reported, a session that finished before the restart included. */
  readonly tokens: ReadonlyMap<AgentSessionId, number>;
  /**
   * The unsupervised time from the first envelope to the last one, without the
   * stretches under a Hold. The time after the last envelope, when the stopping
   * process may no longer have run the Attempt, does not count.
   */
  readonly unsupervised: Duration.Duration;
  /** The parent's Hold was still placed: it outlives the restart, while a held child does not survive it. */
  readonly parentHeld: boolean;
  /** The ceilings whose warning steer the transcript holds, so the guard does not send it again. */
  readonly warned: ReadonlySet<RunawayCeiling>;
}

/** One armed ceiling: the limit that trips the guard and the point at which it warns first. */
interface Ceiling {
  readonly limit: number;
  readonly warnAt: number;
}

const ceiling = (limit: number): Ceiling => ({ limit, warnAt: limit * WARNING_FRACTION });

type Warn = (ceiling: RunawayCeiling, message: string) => Effect.Effect<void>;
type Observer = (envelope: AttemptChannel.Envelope) => Effect.Effect<void, RunawayFailure>;

/** Keeps each session's highest token report; reports are cumulative. Returns whether `envelope` was one. */
const recordTokens = (
  reported: Map<AgentSessionId, number>,
  envelope: AttemptChannel.Envelope,
): boolean => {
  const payload = envelope.payload;
  if (payload._tag !== "SessionEvent" || payload.event._tag !== "SessionTokensUpdated")
    return false;
  const { session, totalTokens } = payload.event;
  reported.set(session.id, Math.max(reported.get(session.id) ?? 0, totalTokens));
  return true;
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
 * Applies `envelope` to the sessions under a Hold: an intervention receipt
 * places or removes its target's Hold, and a finished session never holds
 * again, so a late receipt cannot reopen it.
 */
const recordHolds = (
  holds: Set<string>,
  ended: Set<string>,
  envelope: AttemptChannel.Envelope,
): void => {
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
};

/** The ceiling whose warning `envelope` sent: a steer to the parent that ends as the guard's warnings do. */
const warnedCeiling = (envelope: AttemptChannel.Envelope): Option.Option<RunawayCeiling> => {
  if (
    envelope._tag !== "InboundEnvelope" ||
    envelope.target._tag !== "Parent" ||
    envelope.payload._tag !== "Steer"
  ) {
    return Option.none();
  }
  const message = envelope.payload.message;
  return Option.fromNullishOr(
    RunawayCeiling.literals.find((ceiling) =>
      message.endsWith(` ${WARNING_UNITS[ceiling]} ${WARNING_ENDING}`),
    ),
  );
};

/**
 * What the guard of a reattached Attempt resumes from, read from the
 * envelopes its transcript recorded in append order: the tokens each session
 * reported, the unsupervised time, whether the parent is still held, and the
 * warnings already sent.
 */
export const guardSeed = (transcript: ReadonlyArray<AttemptChannel.Envelope>): AttemptGuardSeed => {
  const tokens = new Map<AgentSessionId, number>();
  const warned = new Set<RunawayCeiling>();
  const holds = new Set<string>();
  const ended = new Set<string>();
  let unsupervised = 0;
  let previous = Option.none<number>();
  for (const envelope of transcript) {
    const at = DateTime.toEpochMillis(envelope.sentAt);
    if (Option.isSome(previous) && holds.size === 0) {
      unsupervised += Math.max(0, at - previous.value);
    }
    previous = Option.some(at);
    recordHolds(holds, ended, envelope);
    recordTokens(tokens, envelope);
    const sent = warnedCeiling(envelope);
    if (Option.isSome(sent)) warned.add(sent.value);
  }
  return {
    tokens,
    unsupervised: Duration.millis(unsupervised),
    parentHeld: holds.has("parent"),
    warned,
  };
};

/** Sums the highest reported count per session, the seed's included; tokens keep accumulating through Holds. */
const tokenWatcher = (
  attemptId: AttemptId,
  tokens: Ceiling,
  warn: Warn,
  seed: AttemptGuardSeed,
): Observer => {
  const reported = new Map(seed.tokens);
  let warned = seed.warned.has("tokens");
  return (envelope) =>
    Effect.gen(function* () {
      if (!recordTokens(reported, envelope)) return;
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
        yield* warn("tokens", warning("tokens", consumed, tokens.limit));
      }
    });
};

/**
 * Counts unsupervised milliseconds on top of the seed's: `observe` tracks
 * which sessions are held, the parent included, and `watch` warns at the
 * ceiling's warning point unless the seed's transcript holds that warning
 * already, then trips at its limit. A held Attempt counts nothing and does
 * not trip until it is released.
 */
const wallClockWatcher = Effect.fn("AttemptGuard.wallClockWatcher")(function* (
  attemptId: AttemptId,
  wallClock: Ceiling,
  warn: Warn,
  seed: AttemptGuardSeed,
) {
  const ended = new Set<string>();
  const holds = new Set<string>(seed.parentHeld ? ["parent"] : []);
  const changes = yield* Queue.make<boolean>();
  // Shared by both waits, so the second one starts held when the first ended on a Hold.
  let paused = holds.size > 0;
  const observe: Observer = (envelope) =>
    Effect.gen(function* () {
      const wasHeld = holds.size > 0;
      recordHolds(holds, ended, envelope);
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
    while (remaining > 0 || paused) {
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
    let used = Duration.toMillis(seed.unsupervised);
    if (!seed.warned.has("wall-clock")) {
      yield* unsupervised(wallClock.warnAt - used);
      used = Math.max(used, wallClock.warnAt);
      yield* warn(
        "wall-clock",
        warning("wall-clock", Math.round(used / 6_000) / 10, wallClock.limit / 60_000),
      );
    }
    yield* unsupervised(wallClock.limit - used);
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
  /**
   * Counts the unsupervised time from when it is run, and fails with
   * `RunawayFailure` when the wall-clock ceiling trips; never ends while that
   * ceiling is unarmed.
   */
  readonly tripped: Effect.Effect<never, RunawayFailure>;
}

/**
 * Arms the Attempt ceilings that are configured: Holds pause elapsed
 * execution time; reported tokens continue accumulating. Each armed ceiling
 * sends the parent one warning steer at `WARNING_FRACTION` of its limit.
 * The ceilings count on from `seed`, what the Attempt's transcript recorded so
 * far, so a reattached Attempt trips at the same totals as if the orchestrator
 * had not restarted, and a warning its transcript holds is not sent again.
 * With no ceiling armed the Attempt runs on the channel untouched.
 */
export const attemptGuard = (
  limits: AttemptGuardLimits,
  io: AttemptChannel.Sink,
  seed: AttemptGuardSeed,
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
      tokenWatcher(limits.attemptId, tokens, warn, seed),
    );
    const clock = yield* Effect.transposeOption(
      Option.map(wallClock, (wallClock) =>
        wallClockWatcher(limits.attemptId, wallClock, warn, seed),
      ),
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
      windows: io.windows,
      transcript: io.transcript,
    };
    return {
      sink,
      tripped: Option.match(clock, { onNone: () => Effect.never, onSome: ({ watch }) => watch }),
    };
  });
};
