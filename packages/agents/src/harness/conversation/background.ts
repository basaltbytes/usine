import {
  type AgentSession,
  type BackgroundWork,
  BackgroundWorkUpdated,
} from "@usine/core/agent/session";
import {
  Array as Arr,
  Data,
  Duration,
  Effect,
  Equal,
  Fiber,
  Option,
  Ref,
  type Scope,
  type Semaphore,
} from "effect";
import type { AgentSessionError } from "../../runtime.ts";
import type { SessionChannel } from "../session.ts";

/**
 * How long a session that answered waits for a turn after its background work ended, before it
 * returns its answer. A turn that starts later finds the session returned.
 */
export const BACKGROUND_TURN_GRACE = Duration.minutes(5);

/**
 * A timer that ends a wait for background work: `limit` at the configured limit, and `grace` once
 * `BACKGROUND_TURN_GRACE` passes after the work ended without a turn.
 */
export type WaitTimer = "limit" | "grace";

/** The running timers of a wait for background work. */
type WaitTimers = Readonly<Record<WaitTimer, Option.Option<Fiber.Fiber<void, unknown>>>>;

/**
 * The answer of the session's last turn, before the session returns it. `Waiting` waits for the
 * session's background work; `timers` holds the running timers that end that wait, which stop when
 * another answer replaces it or a turn drops it. `Kept` is an answer whose wait ended while the
 * operator supervised the session, kept without an idle report. `Idle` is the idle report under
 * operator supervision. A Release returns a kept answer or an idle report. `limitPassed` marks an
 * answer whose wait for background work ended at its limit, rather than when the work ended.
 */
export type Answer = Data.TaggedEnum<{
  Waiting: { readonly message: string; readonly timers: WaitTimers };
  Kept: { readonly message: string; readonly limitPassed: boolean };
  Idle: { readonly message: string; readonly limitPassed: boolean };
}>;
export const Answer = Data.taggedEnum<Answer>();

/**
 * The log text for an answer whose wait for background work ended at its limit, if `limitPassed`,
 * or after the work ended: why the wait ended, and the answer that it kept.
 */
export const waitEnded = (limitPassed: boolean) =>
  limitPassed
    ? {
        why: "Session's background work outlasted the wait limit",
        kept: "the answer whose wait limit passed",
      }
    : {
        why: "Session's background work ended and no turn started",
        kept: "the answer kept after its background work ended",
      };

/** The part of a conversation's state that its wait for background work reads and changes. */
export interface WaitState {
  readonly held: boolean;
  readonly paused: boolean;
  /** The answer that the session hasn't returned; a later answer replaces it. */
  readonly answer: Option.Option<Answer>;
  /** The latest snapshot of the session's background work, or `None` if the harness doesn't report it. */
  readonly background: Option.Option<ReadonlyArray<BackgroundWork>>;
}

interface WaitOptions<S extends WaitState> {
  readonly session: AgentSession;
  readonly channel: SessionChannel;
  readonly state: Ref.Ref<S>;
  /** The conversation's lock. A timer that ends a wait takes it. */
  readonly mutex: Semaphore.Semaphore;
  /** The conversation's scope, where the timers run. */
  readonly scope: Scope.Scope;
  /**
   * Applies `f` to the state and returns the state before it, stopping the timers of a waiting
   * answer that `f` replaces or drops, except `running`.
   */
  readonly transition: (f: (current: S) => S, running?: WaitTimer) => Effect.Effect<S>;
  /** Returns `message`, or keeps it as the idle report under operator supervision. */
  readonly finish: (
    message: string,
    limitPassed?: boolean,
  ) => Effect.Effect<void, AgentSessionError>;
  /** The minutes that a session that answered waits for its background work, or `None`. */
  readonly maxBackgroundWaitMinutes: Option.Option<number>;
}

/**
 * The wait of a conversation's answer for the session's background work: its limit, its grace
 * period after the work ended, and the snapshots that the adapter reports.
 */
export const backgroundWait = <S extends WaitState>(options: WaitOptions<S>) => {
  const { session, channel, state, mutex, scope, transition, finish } = options;
  /**
   * The wait for background work after an answer, or `None` for no limit. The limit is kept in
   * memory, so a session that was already waiting when the orchestrator restarted has none.
   */
  const backgroundWaitLimit = Option.map(options.maxBackgroundWaitMinutes, Duration.minutes);
  const limitText = Option.match(backgroundWaitLimit, {
    onNone: () => "none",
    onSome: Duration.format,
  });
  /** The log fields that name the session's background work and the wait limit. */
  const backgroundFields = Effect.map(Ref.get(state), ({ background }) => ({
    sessionId: session.id,
    backgroundWorkIds: Option.getOrUndefined(
      Option.map(background, (work) => work.map(({ id }) => id)),
    ),
    limit: limitText,
  }));

  /**
   * Ends the wait for background work when `timer` passes: the wait limit, or the grace period
   * after the work ended. The limit passed only if the latest snapshot still lists work. Finishes
   * with the waiting answer if the session is neither held nor paused. Otherwise keeps the answer,
   * without reporting the session idle, for a later Release or for the recovery after a process
   * restart. An answer that replaces or drops the waiting one stops its timers under the mutex, so
   * a timer that gets the mutex ends its own wait.
   */
  const endWait = Effect.fn("SessionConversation.endWait")(function* (timer: WaitTimer) {
    yield* Effect.annotateCurrentSpan({ sessionId: session.id, endedBy: timer });
    const { answer, held, paused, background } = yield* Ref.get(state);
    const waiting = Option.filter(answer, Answer.$is("Waiting"));
    if (Option.isNone(waiting)) return;
    const { message } = waiting.value;
    const limitPassed = timer === "limit" && !Option.exists(background, Arr.isReadonlyArrayEmpty);
    const { why } = waitEnded(limitPassed);
    const fields = {
      ...(yield* backgroundFields),
      endedBy: timer,
      grace: Duration.format(BACKGROUND_TURN_GRACE),
    };
    if (held || paused) {
      yield* transition(
        (current) => ({
          ...current,
          answer: Option.some(Answer.Kept({ message, limitPassed })),
        }),
        timer,
      );
      yield* Effect.logInfo(
        `${why}; the operator's Hold or pause keeps its answer until a Release`,
        fields,
      );
      return;
    }
    yield* transition((current) => ({ ...current, answer: Option.none() }), timer);
    yield* (limitPassed ? Effect.logWarning : Effect.logInfo)(
      `${why}; returning its answer`,
      fields,
    );
    yield* finish(message, limitPassed);
  }, mutex.withPermits(1));

  /** Starts `timer`, which ends the waiting answer once `after` passes. The caller holds the mutex. */
  const startTimer = (timer: WaitTimer, after: Duration.Duration) =>
    Effect.sleep(after).pipe(Effect.andThen(endWait(timer)), Effect.forkIn(scope));

  /**
   * Waits for background work after `answer`, which replaces the unreturned answer. With a
   * configured limit, returns `answer` once the limit passes. If the operator holds the session
   * when the wait ends, a Release returns `answer` instead, and a paused session stays open until
   * the operator's next message. The caller holds the mutex.
   */
  const awaitBackgroundWork = Effect.fn("SessionConversation.awaitBackgroundWork")(function* (
    answer: string,
  ) {
    yield* Effect.annotateCurrentSpan({ sessionId: session.id });
    const limit = yield* Option.match(backgroundWaitLimit, {
      onNone: () => Effect.succeedNone,
      onSome: (after) => Effect.asSome(startTimer("limit", after)),
    });
    yield* transition((current) => ({
      ...current,
      answer: Option.some(
        Answer.Waiting({ message: answer, timers: { limit, grace: Option.none() } }),
      ),
    }));
    yield* Effect.flatMap(backgroundFields, (fields) =>
      Effect.logInfo("Session is waiting for its background work", fields),
    );
  });

  /**
   * Ends the wait for background work and logs `reason` for each timer that it stops. A started
   * turn also drops the answer that an ended wait kept for a Release; a process restart keeps it,
   * so that the recovery reports it. The caller holds the mutex.
   */
  const cancelWait = Effect.fn("SessionConversation.cancelWait")(function* (
    reason: "turn started" | "process restarted",
  ) {
    yield* Effect.annotateCurrentSpan({ sessionId: session.id });
    const { answer } = yield* transition((current) => ({
      ...current,
      answer: Option.filter(
        current.answer,
        ({ _tag }) => _tag === "Idle" || (_tag === "Kept" && reason === "process restarted"),
      ),
    }));
    if (Option.isNone(answer)) return;
    const fields = { ...(yield* backgroundFields), reason };
    yield* Answer.$match(answer.value, {
      Waiting: ({ timers }) =>
        Effect.gen(function* () {
          if (Option.isSome(timers.limit))
            yield* Effect.logInfo(
              "Session cancelled the wait limit for its background work",
              fields,
            );
          if (Option.isSome(timers.grace))
            yield* Effect.logInfo(
              "Session cancelled the return of its answer after its background work ended",
              fields,
            );
        }),
      Kept: ({ limitPassed }) =>
        reason === "turn started"
          ? Effect.logInfo(
              `The session started a turn; dropping ${waitEnded(limitPassed).kept}`,
              fields,
            )
          : Effect.void,
      Idle: () => Effect.void,
    });
  });

  /**
   * Records `work` as the latest snapshot and reports it if it changed. During a wait, an empty
   * snapshot starts the grace period for a turn, and work that runs again cancels it. The caller
   * holds the mutex.
   */
  const reportBackground = Effect.fn("SessionConversation.reportBackground")(function* (
    work: Option.Option<ReadonlyArray<BackgroundWork>>,
  ) {
    yield* Effect.annotateCurrentSpan({ sessionId: session.id });
    const previous = yield* Ref.getAndUpdate(state, (current) => ({
      ...current,
      background: work,
    }));
    const changed = !Equal.equals(previous.background, work);
    yield* Effect.logInfo("Session reported its background work", {
      ...(yield* backgroundFields),
      reported: Option.isSome(work),
      changed,
    });
    if (changed) yield* channel.emit(BackgroundWorkUpdated.make({ session, work }));
    const waiting = Option.filter(previous.answer, Answer.$is("Waiting"));
    if (Option.isNone(waiting)) return;
    const { message, timers } = waiting.value;
    /** Replaces the waiting answer's grace timer with `grace`; the wait stays the same. */
    const setGrace = (grace: WaitTimers["grace"]) =>
      Ref.update(state, (current) => ({
        ...current,
        answer: Option.some(Answer.Waiting({ message, timers: { ...timers, grace } })),
      }));
    if (Option.exists(work, Arr.isReadonlyArrayEmpty)) {
      if (Option.isSome(timers.grace)) return;
      const grace = yield* startTimer("grace", BACKGROUND_TURN_GRACE);
      yield* setGrace(Option.some(grace));
      yield* Effect.logInfo(
        "Session's background work ended; it returns its answer unless a turn starts within the grace period",
        { ...(yield* backgroundFields), grace: Duration.format(BACKGROUND_TURN_GRACE) },
      );
      return;
    }
    if (Option.isNone(timers.grace)) return;
    yield* Fiber.interrupt(timers.grace.value);
    yield* setGrace(Option.none());
    yield* Effect.flatMap(backgroundFields, (fields) =>
      Effect.logInfo("Session's background work runs again; it keeps waiting for the work", fields),
    );
  });

  return { awaitBackgroundWork, cancelWait, reportBackground };
};
