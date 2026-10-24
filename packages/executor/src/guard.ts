import type { AttemptId } from "@usine/core/attempt";
import type { AgentSession, AgentSessionId } from "@usine/core/agent/session";
import type * as AttemptChannel from "@usine/core/attempt/channel";
import { AttemptFailure, RunawayCeiling, RunawayFailure } from "@usine/core/attempt/failure";
import { Clock, Duration, Effect, Option, Queue } from "effect";

/** The fraction of a ceiling at which the parent gets one warning steer. */
const WARNING_FRACTION = 0.8;

/**
 * The interval for recording unsupervised time while it grows. An orchestrator that exits
 * without shutting down loses at most this much (#178).
 */
const RECORD_INTERVAL = Duration.seconds(30);

/** The timeout for the final unsupervised-time record when the guard stops. */
const LAST_RECORD_GRACE = Duration.seconds(5);

/** The suffix of every warning steer, after the ceiling's unit. */
const WARNING_ENDING = "used by this Attempt; commit and push your work now.";

const WARNING_UNITS = {
  tokens: "tokens",
  "wall-clock": "minutes",
} as const satisfies Record<RunawayCeiling, string>;

const warning = (ceiling: RunawayCeiling, used: number, limit: number): string =>
  `${used} of ${limit} ${WARNING_UNITS[ceiling]} ${WARNING_ENDING}`;

export interface AttemptGuardLimits {
  readonly attemptId: AttemptId;
  /** The wall-clock ceiling in minutes, or `None` for no limit. */
  readonly maxAttemptMinutes: Option.Option<number>;
  /** The token ceiling across the parent and all children, or `None` for no limit. */
  readonly maxAttemptTokens: Option.Option<number>;
  /**
   * Sends the warning steer to the parent session. Can wait for the parent's channel without
   * delaying the ceiling checks; failures are logged and don't fail the Attempt.
   */
  readonly warn: (message: string) => Effect.Effect<void, AttemptFailure>;
  /**
   * Persists the unsupervised time counted so far, including the seed, for a later reattachment.
   * Called every `RECORD_INTERVAL` while the count grows and once on stop; failures are logged.
   */
  readonly recordUnsupervised: (
    unsupervised: Duration.Duration,
  ) => Effect.Effect<void, AttemptFailure>;
}

/**
 * The counts restored from earlier guards, so a reattached Attempt's guard continues instead of
 * starting over (#178). Empty for a new Attempt.
 */
export interface AttemptGuardSeed {
  /** The highest token count each session reported, including sessions that finished before the restart. */
  readonly tokens: ReadonlyMap<AgentSessionId, number>;
  /** The unsupervised time recorded by earlier guards, excluding time the orchestrator was stopped. */
  readonly unsupervised: Duration.Duration;
  /** Whether the parent was on Hold at the restart. A parent's Hold persists across restarts; a child's doesn't. */
  readonly parentHeld: boolean;
  /** The ceilings whose warning steer is already in the transcript. */
  readonly warned: ReadonlySet<RunawayCeiling>;
}

interface Ceiling {
  readonly limit: number;
  readonly warnAt: number;
}

const ceiling = (limit: number): Ceiling => ({ limit, warnAt: limit * WARNING_FRACTION });

/** A function that queues a ceiling's warning without waiting for delivery. */
type Warn = (ceiling: RunawayCeiling, message: string) => Effect.Effect<void>;
type Observer = (envelope: AttemptChannel.Envelope) => Effect.Effect<void, RunawayFailure>;

/** Stores the session's token count from `envelope` if higher, because reports are cumulative. Returns whether `envelope` was a token report. */
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

/** Returns the Hold key: `"parent"` for the parent session, or the session ID for a child. */
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
 * Updates the held sessions from `envelope`. An intervention receipt places or removes its
 * target's Hold; a finished session is never held again, so a late receipt is ignored.
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

/** Returns the ceiling whose warning steer `envelope` is: a parent steer that ends with the ceiling's unit and `WARNING_ENDING`. */
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

/** Returns a reattached guard's seed from `unsupervised` and the transcript `envelopes` in append order. */
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
 * Returns a watcher that sums the highest reported count per session, including the seed;
 * Holds don't pause it. `resume` checks the restored total immediately, so it can warn or trip
 * without another report (#178).
 */
const tokenWatcher = (
  attemptId: AttemptId,
  tokens: Ceiling,
  warn: Warn,
  seed: AttemptGuardSeed,
) => {
  const reported = new Map(seed.tokens);
  let warned = seed.warned.has("tokens");
  /** Trips at the limit, or warns once past the warning point. Returns the total. */
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
 * Returns a watcher that counts unsupervised milliseconds on top of the seed, paused while any
 * session is held. `watch` warns at the warning point unless the warning is already in the
 * transcript, then trips at the limit. While running, it records the count every
 * `RECORD_INTERVAL` if it grew, and once more on interruption (#178).
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
  /** Signals `watch` when supervision changes; one pending signal is enough. */
  const changed = yield* Queue.sliding<void>(1);
  /** Whether `watch` has started; nothing is counted before. */
  let watching = false;
  /** The unsupervised milliseconds of completed intervals, including the seed. */
  let counted = Duration.toMillis(seed.unsupervised);
  /** The start of the current unsupervised interval, or `None` while held or before `watch` runs. */
  let since = Option.none<number>();
  /** The unsupervised milliseconds last persisted, initially the seed's. */
  let recorded = counted;
  const usedAt = (now: number) =>
    counted + Option.match(since, { onNone: () => 0, onSome: (began) => now - began });
  /**
   * Applies the current Holds at `now`: a Hold ends the current interval, and a release while
   * `watch` runs starts one.
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
  /** Waits until `until` unsupervised milliseconds are counted and returns the count. Never returns while held. */
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
  /** Records the unsupervised time if it grew since the last record; logs a failure. */
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
  // Bounded by LAST_RECORD_GRACE; on timeout, the time since the previous record is lost.
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

export interface AttemptGuard {
  /**
   * The Attempt's sink, wrapped. The append that reaches the token ceiling fails with
   * `RunawayFailure`. An append that reaches the warning point queues the warning for `tripped`
   * without waiting, because awaiting delivery inside `append` would deadlock.
   */
  readonly sink: AttemptChannel.Sink;
  /**
   * Checks the restored token total, counts unsupervised time, and sends queued warnings through
   * `limits.warn`. Fails with `RunawayFailure` when the restored token total or the wall-clock
   * ceiling trips; never succeeds. On interruption, records the counted time within
   * `LAST_RECORD_GRACE`.
   */
  readonly tripped: Effect.Effect<never, RunawayFailure>;
}

/**
 * Arms the configured Attempt ceilings, each with one warning steer at `WARNING_FRACTION` of
 * its limit. Holds pause the wall clock; tokens keep accumulating. Counts continue from `seed`,
 * so a reattached Attempt trips at the same totals as without the restart. With no ceiling set,
 * `sink` is `io` and `tripped` never completes.
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
    const warnings = yield* Queue.unbounded<{
      readonly ceiling: RunawayCeiling;
      readonly message: string;
    }>();
    const warn: Warn = (ceiling, message) =>
      Effect.logInfo("Warning the Attempt before its ceiling", {
        attemptId: limits.attemptId,
        ceiling,
      }).pipe(Effect.andThen(Queue.offer(warnings, { ceiling, message })), Effect.asVoid);
    const deliver = Effect.fn("AttemptGuard.deliverWarning")(function* (
      ceiling: RunawayCeiling,
      message: string,
    ) {
      yield* Effect.annotateCurrentSpan({ attemptId: limits.attemptId, ceiling });
      yield* limits.warn(message).pipe(
        Effect.tap(() =>
          Effect.logInfo("Delivered the Attempt's ceiling warning", {
            attemptId: limits.attemptId,
            ceiling,
          }),
        ),
        Effect.tapError((error) =>
          Effect.logWarning("Attempt ceiling warning was not delivered", {
            attemptId: limits.attemptId,
            ceiling,
            errorTag: error._tag,
          }),
        ),
        Effect.ignore,
      );
    });
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
    const restoredTokens = Option.match(meter, {
      onNone: () => Effect.never,
      onSome: ({ resume }) => Effect.andThen(resume, Effect.never),
    });
    const wallClockTrip = Option.match(clock, {
      onNone: () => Effect.never,
      onSome: ({ watch }) => watch,
    });
    // Delivers warnings in a separate loop so a delivery waiting for the parent's channel doesn't
    // delay a trip (#178).
    const delivery = Effect.forever(
      Effect.flatMap(Queue.take(warnings), ({ ceiling, message }) => deliver(ceiling, message)),
    );
    return {
      sink,
      tripped: Effect.raceFirst(Effect.raceFirst(restoredTokens, wallClockTrip), delivery),
    };
  });
};
