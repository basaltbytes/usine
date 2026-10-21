import type { AttemptId } from "@usine/core/attempt";
import type { AgentSession, AgentSessionId } from "@usine/core/agent/session";
import type * as AttemptChannel from "@usine/core/attempt/channel";
import { AttemptFailure, RunawayCeiling, RunawayFailure } from "@usine/core/attempt/failure";
import { Clock, Duration, Effect, Option, Queue } from "effect";

/** The share of a ceiling at which the guard warns the parent session once, before tripping. */
const WARNING_FRACTION = 0.8;

/**
 * How often a guard with a wall-clock ceiling records the unsupervised time
 * it counted while that time grows: each orchestrator that stops without
 * shutting down loses at most this much of it. That tolerance is accepted
 * (#178): exact accounting across a crash would need a durable write per tick.
 */
const RECORD_INTERVAL = Duration.seconds(30);

/** How long a stopping guard waits to record the unsupervised time it counted last. */
const LAST_RECORD_GRACE = Duration.seconds(5);

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
  /**
   * Keeps the unsupervised time counted so far, the seed's included, where
   * the guard of a reattachment reads it back as its seed. The wall clock
   * records it every `RECORD_INTERVAL` while it counts and once more when it
   * stops; failures are logged and never fail the Attempt.
   */
  readonly recordUnsupervised: (
    unsupervised: Duration.Duration,
  ) => Effect.Effect<void, AttemptFailure>;
}

/**
 * What an Attempt's guards counted so far, which its next guard goes on from:
 * a reattached Attempt's guard resumes where the guard before the orchestrator
 * restart stopped instead of starting over (#178), and a fresh Attempt's
 * empty transcript gives the guard nothing to resume.
 */
export interface AttemptGuardSeed {
  /** The highest token count each session reported, a session that finished before the restart included. */
  readonly tokens: ReadonlyMap<AgentSessionId, number>;
  /**
   * The unsupervised time the earlier guards recorded with
   * `recordUnsupervised`. Only a running guard counts, so the quiet time
   * before a restart counts and the time the orchestrator was stopped does
   * not. The transcript cannot tell either: it shows neither when the
   * orchestrator stopped nor where a restart fell.
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
 * What the guard of a reattached Attempt resumes from: the `unsupervised`
 * time its earlier guards recorded, and from the envelopes its transcript
 * recorded in append order, the tokens each session reported, whether the
 * parent is still held, and the warnings already sent.
 */
export const guardSeed = (
  transcript: ReadonlyArray<AttemptChannel.Envelope>,
  unsupervised: Duration.Duration,
): AttemptGuardSeed => {
  const tokens = new Map<AgentSessionId, number>();
  const warned = new Set<RunawayCeiling>();
  const holds = new Set<string>();
  const ended = new Set<string>();
  for (const envelope of transcript) {
    recordHolds(holds, ended, envelope);
    recordTokens(tokens, envelope);
    const sent = warnedCeiling(envelope);
    if (Option.isSome(sent)) warned.add(sent.value);
  }
  return { tokens, unsupervised, parentHeld: holds.has("parent"), warned };
};

/**
 * Sums the highest reported count per session, the seed's included; tokens
 * keep accumulating through Holds. `observe` checks the total at each report,
 * and `resume` checks it as it stands: a total restored from the seed warns
 * or trips without waiting for another report, which a quiet parent may never
 * send (#178).
 */
const tokenWatcher = (
  attemptId: AttemptId,
  tokens: Ceiling,
  warn: Warn,
  seed: AttemptGuardSeed,
) => {
  const reported = new Map(seed.tokens);
  let warned = seed.warned.has("tokens");
  /** Trips at the limit, else warns once past the warning point; returns the total. */
  const check = Effect.gen(function* () {
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
    return consumed;
  });
  const observe: Observer = (envelope) =>
    recordTokens(reported, envelope) ? Effect.asVoid(check) : Effect.void;
  const resume = Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan({ attemptId });
    const consumed = yield* check;
    yield* Effect.logDebug("Attempt token total is under its limit as its guard starts", {
      attemptId,
      consumed,
      maxAttemptTokens: tokens.limit,
      warned,
    });
  }).pipe(Effect.withSpan("AttemptGuard.resumeTokens"));
  return { observe, resume };
};

/**
 * Counts unsupervised milliseconds on top of the seed's: `observe` tracks
 * which sessions are held, the parent included, and stops or resumes the
 * count as each Hold receipt arrives, and `watch` warns at the ceiling's
 * warning point unless the seed's transcript holds that warning already, then
 * trips at its limit. A held Attempt counts nothing and does not trip until
 * it is released, also when the Hold arrived while `watch` was delivering its
 * warning. While `watch` runs, it records the time it counted every
 * `RECORD_INTERVAL` when that time grew, and once more when it is
 * interrupted, as when this process stops, so the guard of a reattachment
 * goes on from it (#178).
 */
const wallClockWatcher = Effect.fn("AttemptGuard.wallClockWatcher")(function* (
  attemptId: AttemptId,
  wallClock: Ceiling,
  warn: Warn,
  record: AttemptGuardLimits["recordUnsupervised"],
  seed: AttemptGuardSeed,
) {
  const ended = new Set<string>();
  const holds = new Set<string>(seed.parentHeld ? ["parent"] : []);
  /** Wakes a wait of `watch` when supervision changes; one pending wake is enough for it to look again. */
  const changed = yield* Queue.sliding<void>(1);
  /** Whether `watch` has started: nothing counts before the launch registered the session. */
  let watching = false;
  /** The unsupervised milliseconds of the stretches that ended, the seed's included. */
  let counted = Duration.toMillis(seed.unsupervised);
  /** When the unsupervised stretch being counted began; none while held, and before `watch` runs. */
  let since = Option.none<number>();
  /** The unsupervised milliseconds `record` kept last, or the seed's. */
  let recorded = counted;
  const usedAt = (now: number) =>
    counted + Option.match(since, { onNone: () => 0, onSome: (began) => now - began });
  /**
   * Applies the current Holds to the count at `now`: a Hold ends the stretch
   * being counted, and a release while `watch` runs begins one. Both happen
   * as the receipt arrives, so a wait busy elsewhere, as on delivering the
   * warning, finds the count already stopped when it compares it to a limit.
   */
  const supervise = (now: number) => {
    if (holds.size > 0) {
      counted = usedAt(now);
      since = Option.none();
    } else if (watching && Option.isNone(since)) {
      since = Option.some(now);
    }
  };
  const observe: Observer = (envelope) =>
    Effect.gen(function* () {
      const wasHeld = holds.size > 0;
      recordHolds(holds, ended, envelope);
      const isHeld = holds.size > 0;
      if (wasHeld === isHeld) return;
      supervise(yield* Clock.currentTimeMillis);
      yield* Effect.logInfo("Attempt wall-clock supervision changed", {
        attemptId,
        heldSessions: holds.size,
        parentHeld: holds.has("parent"),
        unsupervisedMillis: counted,
      });
      yield* Queue.offer(changed, undefined);
    });
  /** Waits until `until` unsupervised milliseconds are counted, and returns the count; never ends while held. */
  const unsupervised = Effect.fn("AttemptGuard.unsupervised")(function* (until: number) {
    yield* Effect.annotateCurrentSpan({ attemptId, untilMillis: until });
    for (;;) {
      if (holds.size > 0) {
        yield* Queue.take(changed);
        continue;
      }
      const used = usedAt(yield* Clock.currentTimeMillis);
      if (used >= until) return used;
      yield* Queue.take(changed).pipe(Effect.timeoutOption(until - used));
    }
  });
  /** Records the unsupervised time counted so far if it grew since the last record; a failure is logged. */
  const recordCounted = Effect.fn("AttemptGuard.recordUnsupervised")(function* () {
    yield* Effect.annotateCurrentSpan({ attemptId });
    const used = usedAt(yield* Clock.currentTimeMillis);
    if (used <= recorded) {
      yield* Effect.logDebug("Attempt unsupervised time has not grown since its last record", {
        attemptId,
        unsupervisedMillis: used,
      });
      return;
    }
    yield* record(Duration.millis(used)).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          recorded = Math.max(recorded, used);
        }),
      ),
      Effect.tapError((error) =>
        Effect.logWarning("Could not record the Attempt's unsupervised time", {
          attemptId,
          unsupervisedMillis: used,
          errorTag: error._tag,
        }),
      ),
      Effect.ignore,
    );
  });
  // A stopping process must not wait on storage for long: the time since the
  // previous record is then lost, as when the process does not shut down.
  const lastRecord = recordCounted().pipe(
    Effect.timeoutOption(LAST_RECORD_GRACE),
    Effect.flatMap(
      Option.match({
        onSome: () => Effect.void,
        onNone: () =>
          Effect.logWarning(
            "Recording the Attempt's unsupervised time exceeded its grace as its guard stopped",
            { attemptId, graceMillis: Duration.toMillis(LAST_RECORD_GRACE) },
          ),
      }),
    ),
  );
  const watch = Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan({ attemptId });
    watching = true;
    supervise(yield* Clock.currentTimeMillis);
    if (!seed.warned.has("wall-clock")) {
      const used = yield* unsupervised(wallClock.warnAt);
      yield* warn(
        "wall-clock",
        warning("wall-clock", Math.round(used / 6_000) / 10, wallClock.limit / 60_000),
      );
    }
    yield* unsupervised(wallClock.limit);
    yield* Effect.logWarning("Attempt reached its unsupervised wall-clock limit", {
      attemptId,
      maxAttemptMinutes: wallClock.limit / 60_000,
    });
    return yield* new RunawayFailure({ ceiling: "wall-clock" });
  }).pipe(
    Effect.raceFirst(
      Effect.forever(Effect.sleep(RECORD_INTERVAL).pipe(Effect.andThen(recordCounted()))),
    ),
    Effect.onInterrupt(() => lastRecord),
    Effect.withSpan("AttemptGuard.watch"),
  );
  return { observe, watch };
});

/** One Attempt under its ceilings: the sink that meters it and the watch of its unsupervised time. */
export interface AttemptGuard {
  /** Appends through to the Attempt's sink; the append that reaches the token ceiling fails with `RunawayFailure`. */
  readonly sink: AttemptChannel.Sink;
  /**
   * Checks the token total, the seed's included, and counts the unsupervised
   * time from when it is run, and fails with `RunawayFailure` when the
   * restored token total or the wall-clock ceiling trips; never ends
   * otherwise. A token report that reaches the limit later fails its `append`
   * instead. Interrupting it records the time it counted, within a short
   * grace.
   */
  readonly tripped: Effect.Effect<never, RunawayFailure>;
}

/**
 * Arms the Attempt ceilings that are configured: Holds pause elapsed
 * execution time; reported tokens continue accumulating. Each armed ceiling
 * sends the parent one warning steer at `WARNING_FRACTION` of its limit.
 * The ceilings count on from `seed`, what the Attempt's earlier guards
 * counted, so a reattached Attempt trips at the same totals as if the
 * orchestrator had not restarted, and a warning its transcript holds is not
 * sent again. `tripped` checks the restored token total as it starts, since
 * a quiet parent may report no more usage. The wall clock records the time it
 * counted through `limits.recordUnsupervised` for the next seed. With no
 * ceiling armed the Attempt runs on the channel untouched.
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
    const meter = Option.map(tokens, (tokens) =>
      tokenWatcher(limits.attemptId, tokens, warn, seed),
    );
    const clock = yield* Effect.transposeOption(
      Option.map(wallClock, (wallClock) =>
        wallClockWatcher(limits.attemptId, wallClock, warn, limits.recordUnsupervised, seed),
      ),
    );
    const sink: AttemptChannel.Sink = {
      append: Effect.fn("AttemptGuard.append")(function* (direction, envelope) {
        yield* Effect.annotateCurrentSpan({ attemptId: limits.attemptId });
        yield* io.append(direction, envelope);
        if (Option.isSome(meter)) yield* meter.value.observe(envelope);
        if (Option.isSome(clock)) yield* clock.value.observe(envelope);
      }),
      salvage: io.salvage,
      comments: io.comments,
      windows: io.windows,
      transcript: io.transcript,
    };
    // The restored token total is checked beside the wall clock, so delivering
    // its warning does not hold back the clock's start.
    const restoredTokens = Option.match(meter, {
      onNone: () => Effect.never,
      onSome: ({ resume }) => Effect.andThen(resume, Effect.never),
    });
    const wallClockTrip = Option.match(clock, {
      onNone: () => Effect.never,
      onSome: ({ watch }) => watch,
    });
    return { sink, tripped: Effect.raceFirst(restoredTokens, wallClockTrip) };
  });
};
