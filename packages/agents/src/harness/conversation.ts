import {
  type AgentSession,
  type BackgroundWork,
  BackgroundWorkUpdated,
  type OperatorMessageId,
  OperatorMessageRead,
  SessionIdle,
  SessionResumed,
} from "@usine/core/agent/session";
import {
  InterventionState,
  type OperatorAction,
  type OperatorMessage,
  type Steer,
} from "@usine/core/attempt/channel";
import {
  Array as Arr,
  Data,
  Deferred,
  Duration,
  Effect,
  Equal,
  FiberHandle,
  Option,
  Predicate,
  Ref,
  Semaphore,
} from "effect";
import {
  type AgentSessionError,
  type InterruptedTool,
  type OnDelivery,
  SessionOperationError,
} from "../runtime.ts";
import type { ContinuationPolicy } from "./continuation.ts";
import { type Inbox, match, Receipt, type ReadPoint, type Unread } from "./receipts.ts";
import type { SessionChannel } from "./session.ts";

/**
 * How the harness accepted an operator message: `read` if it starts the next turn of an idle
 * session or joins the running turn immediately, `queued` if the harness reads it at its next
 * boundary, and `next-turn` if no turn runs and the harness reads it when the next turn starts,
 * before that turn's tool calls.
 */
export type MessageTaken = "read" | "queued" | "next-turn";

/** The native records of input that a restored session counted; see `Inbox`. */
export interface RestoredItems {
  readonly counted: ReadonlyArray<string>;
  readonly turn: Option.Option<string>;
  readonly saved: ReadonlyArray<string>;
}

interface ConversationOptions<S> {
  readonly session: AgentSession;
  readonly channel: SessionChannel;
  /** The supervision, idle report, and unread messages restored, and the journal to save to. */
  readonly policy: ContinuationPolicy;
  /** Restored messages already submitted to a retained native process. */
  readonly submitted?: ReadonlyArray<OperatorMessageId>;
  /** The native records of input that the restored session counted. */
  readonly items?: RestoredItems;
  /** Decodes what a harness signal says about the operator messages that the session read. */
  readonly decode: (signal: S) => ReadonlyArray<Receipt>;
  /**
   * Queues a message during a turn, or starts another turn in an idle session. Unless it returns
   * `read`, the harness reports the read later in a signal for `observe`.
   */
  readonly send: (
    message: string,
    activity: "running" | "idle",
    id: OperatorMessageId,
  ) => Effect.Effect<MessageTaken, AgentSessionError>;
  /** Requests a pause at the harness's next boundary. */
  readonly pause: Effect.Effect<void, AgentSessionError>;
  /** Releases harness resources; runs only when the session is about to return. */
  readonly beforeFinish: Effect.Effect<void, AgentSessionError>;
  /**
   * The minutes that a session that answered waits for its background work to end or start a
   * turn, or `None` for no limit.
   */
  readonly maxBackgroundWaitMinutes: Option.Option<number>;
}

/**
 * How long a session that answered waits for a turn after its background work ended, before it
 * returns its answer. A turn that starts later finds the session returned.
 */
export const BACKGROUND_TURN_GRACE = Duration.minutes(5);

/**
 * The answer of the session's last turn, before the session returns it. `Waiting` waits for the
 * session's background work. `Kept` is an answer whose wait ended while the operator supervised the
 * session, kept without an idle report. `Idle` is the idle report under operator supervision. A
 * Release returns a kept answer or an idle report. `limitPassed` marks an answer whose wait for
 * background work ended at its limit, rather than when the work ended.
 */
type Answer = Data.TaggedEnum<{
  Waiting: { readonly message: string };
  Kept: { readonly message: string; readonly limitPassed: boolean };
  Idle: { readonly message: string; readonly limitPassed: boolean };
}>;
const Answer = Data.taggedEnum<Answer>();

/**
 * The log text for an answer whose wait for background work ended at its limit, if `limitPassed`,
 * or after the work ended: why the wait ended, and the answer that it kept.
 */
const waitEnded = (limitPassed: boolean) =>
  limitPassed
    ? {
        why: "Session's background work outlasted the wait limit",
        kept: "the answer whose wait limit passed",
      }
    : {
        why: "Session's background work ended and no turn started",
        kept: "the answer kept after its background work ended",
      };

/** An operator message that the harness hasn't read, and what to run when it is read or not. */
interface QueuedMessage extends Unread {
  readonly onDelivery: OnDelivery;
}

/** The supervision of one conversation and the operator input that its session read. */
interface ConversationState {
  readonly held: boolean;
  readonly paused: boolean;
  /** The answer that the session hasn't returned; a later answer replaces it. */
  readonly answer: Option.Option<Answer>;
  /**
   * The session's tool-call count when it last read an operator message or steer, or `None` after
   * its own input, such as a continuation turn.
   */
  readonly operatorInput: Option.Option<number>;
  readonly closing: boolean;
  /** The latest snapshot of the session's background work, or `None` if the harness doesn't report it. */
  readonly background: Option.Option<ReadonlyArray<BackgroundWork>>;
  /** Completes when operator input ends the current pause. */
  readonly resume: Deferred.Deferred<void>;
  readonly inbox: Inbox<QueuedMessage>;
}

/**
 * Keeps an idle child addressable while on Hold, and keeps an interrupted session waiting until
 * guidance arrives. The adapter's `decode` turns each harness signal that it `observe`s into
 * receipts, and `match` decides which queued operator messages they acknowledge. The conversation
 * reports each message that the session reads, at once or later, with `OperatorMessageRead`, and
 * a queued one also through its `onDelivery`; one still queued when the scope closes is reported
 * unread. The result's `answeredOperator` is true when the session read an operator message or
 * steer after its last tool call.
 *
 * The adapter reports each snapshot of the session's background work with `reportBackground`, and
 * the conversation records each change with `BackgroundWorkUpdated`. An answer while the snapshot
 * lists work waits for that work, up to `maxBackgroundWaitMinutes`: a turn that the work starts
 * replaces the answer, and an answer whose work ended returns once `BACKGROUND_TURN_GRACE` passes
 * without a turn. The adapter calls `turnStarted`, `turnEnded`, and `processRestarted` from one
 * fiber or several: each takes the conversation's lock.
 */
export const sessionConversation = Effect.fn("SessionConversation.make")(function* <S>(
  options: ConversationOptions<S>,
) {
  const { session, channel, policy } = options;
  const { restored, journal } = policy;
  const mutex = yield* Semaphore.make(1);
  const restoredAt = yield* channel.toolCalls;
  const restoredAfter = yield* channel.toolResults;
  const submitted = options.submitted ?? [];
  const resume = yield* Deferred.make<void>();
  const state = yield* Ref.make<ConversationState>({
    held: restored.held,
    paused: restored.paused,
    answer: Option.none(),
    operatorInput: Option.none(),
    closing: false,
    background: Option.none(),
    resume,
    inbox: {
      unread: restored.unread.map((message) => ({
        ...message,
        onDelivery: (delivered) => journal.delivered(message.id, delivered),
        queuedAfter: restoredAfter,
        sent: submitted.includes(message.id),
        turnStart: Option.none(),
      })),
      own: [],
      counted: options.items?.counted ?? [],
      turn: options.items?.turn ?? Option.none(),
      saved: options.items?.saved ?? [],
    },
  });
  const updateInbox = (f: (inbox: Inbox<QueuedMessage>) => Inbox<QueuedMessage>) =>
    Ref.update(state, (current) => ({ ...current, inbox: f(current.inbox) }));

  /** Records that the session read operator input at tool-call count `count`. */
  const readOperatorInputAt = (count: number) =>
    Ref.update(state, (current) => ({
      ...current,
      operatorInput: Option.some(
        Option.match(current.operatorInput, {
          onNone: () => count,
          onSome: (at) => Math.max(at, count),
        }),
      ),
    }));
  const readOperatorInput = Effect.flatMap(channel.toolCalls, readOperatorInputAt);
  /**
   * Returns the tool-call count where a turn folded in a message queued after `results` finished
   * tool calls: the next tool result, or now if none came since.
   */
  const foldedAt = (results: number) =>
    channel
      .toolCallsAtResult(results)
      .pipe(
        Effect.flatMap(Option.match({ onSome: Effect.succeed, onNone: () => channel.toolCalls })),
      );
  /** Emits that the session read `message` and records where. */
  const markRead = ({ id, queuedAfter }: Unread, at: ReadPoint) =>
    channel
      .emit(OperatorMessageRead.make({ session, messageId: id }))
      .pipe(
        Effect.andThen(
          at === "now"
            ? readOperatorInput
            : at === "turn"
              ? Effect.flatMap(foldedAt(queuedAfter), readOperatorInputAt)
              : at === "restored"
                ? Effect.void
                : readOperatorInputAt(at),
        ),
      );

  /** Reports the messages that a receipt acknowledged as read, with the current session state. */
  const deliver = (
    read: ReadonlyArray<{ readonly message: QueuedMessage; readonly at: ReadPoint }>,
  ) =>
    Effect.gen(function* () {
      if (read.length === 0) return;
      const { held, paused, inbox } = yield* Ref.get(state);
      yield* Effect.logInfo("The session read queued operator messages", {
        sessionId: session.id,
        read: read.length,
        stillQueued: inbox.unread.length,
        at: read.map(({ at }) => at),
      });
      for (const { message, at } of read) yield* markRead(message, at);
      const delivered = InterventionState.make({ held, paused });
      yield* Effect.forEach(read, ({ message }) => message.onDelivery(Option.some(delivered)), {
        discard: true,
      });
    });

  /**
   * Applies `receipt`: saves the native records that it counted, then reports the messages that
   * it acknowledges. The caller holds the mutex.
   */
  const receive = Effect.fn("SessionConversation.receive")(function* (receipt: Receipt) {
    yield* Effect.annotateCurrentSpan({ sessionId: session.id, receipt: receipt._tag });
    const calls = yield* channel.toolCalls;
    const matched = match((yield* Ref.get(state)).inbox, receipt, calls);
    if (Option.isSome(matched.repeated))
      yield* Effect.logInfo("Skipping a native input record that the session already counted", {
        sessionId: session.id,
        turnId: matched.repeated.value.turn,
        itemId: matched.repeated.value.id,
      });
    if (Option.isSome(matched.own))
      yield* Effect.logInfo(
        "The harness recorded the session's own input; no operator message read",
        {
          sessionId: session.id,
          ...Option.match(matched.own.value.item, {
            onNone: () => ({}),
            onSome: ({ turn, id }) => ({ turnId: turn, itemId: id }),
          }),
        },
      );
    if (matched.folded > 0)
      yield* Effect.logInfo(
        "A turn started without some sent operator messages; the session reads them where the turn folds them in",
        { sessionId: session.id, later: matched.folded },
      );
    if (matched.turnsQueued > 0)
      yield* Effect.logInfo("Unread operator messages each start a turn after this one", {
        sessionId: session.id,
        turns: matched.turnsQueued,
        toolCalls: calls,
      });
    // Saved before the reads, so a restart never matches these records to another message.
    if (Option.isSome(matched.save)) yield* journal.received(matched.save.value);
    yield* updateInbox(() => matched.inbox);
    yield* deliver(matched.read);
    return {
      read: matched.read.map(({ message }) => message.id),
      repeated: Option.isSome(matched.repeated) ? 1 : 0,
    };
  });

  /**
   * Records how the harness took queued message `id`: a read is reported now, and a message for
   * the next turn notes where that turn starts. The caller holds the mutex.
   */
  const took = (id: OperatorMessageId, taken: MessageTaken) =>
    Effect.gen(function* () {
      const calls = yield* channel.toolCalls;
      yield* updateInbox((inbox) => ({
        ...inbox,
        unread: inbox.unread.map((message) =>
          message.id === id
            ? {
                ...message,
                sent: true,
                turnStart: taken === "next-turn" ? Option.some(calls) : Option.none(),
              }
            : message,
        ),
      }));
      if (taken === "read") {
        yield* receive(Receipt.ById({ ids: [id], at: "now", opensTurn: false }));
        return;
      }
      if (taken === "next-turn")
        yield* Effect.logInfo("The session reads the operator message when its next turn starts", {
          sessionId: session.id,
          toolCalls: calls,
        });
    });

  /**
   * Sends the session's own input `message`, such as its task, with `send`, which starts a turn.
   * The harness's record of it in that turn then reads no operator message with the same text. If
   * `send` fails, `message` stays an own input until a turn ends or `recover` clears the own
   * inputs. The caller holds the mutex.
   */
  const sendOwn = <A, E>(message: string, send: (message: string) => Effect.Effect<A, E>) =>
    updateInbox((inbox) => ({ ...inbox, own: [...inbox.own, message] })).pipe(
      Effect.andThen(send(message)),
    );

  /**
   * Drops the own inputs that the harness didn't record in the turn that ended, so that no record
   * in a later turn takes an operator message's read. The caller holds the mutex.
   */
  const turnEnded = Effect.fn("SessionConversation.turnEnded")(function* () {
    yield* Effect.annotateCurrentSpan({ sessionId: session.id });
    const { inbox } = yield* Ref.getAndUpdate(state, (current) => ({
      ...current,
      inbox: { ...current.inbox, own: [] },
    }));
    if (inbox.own.length > 0)
      yield* Effect.logInfo(
        "The turn ended without the harness's record of the session's own input; dropping it",
        { sessionId: session.id, dropped: inbox.own.length },
      );
  });

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const unread = yield* Ref.modify(state, (current) => [
        current.inbox.unread,
        { ...current, inbox: { ...current.inbox, unread: [] } },
      ]);
      if (unread.length === 0) return;
      yield* Effect.logWarning("The session stopped before it read queued operator messages", {
        sessionId: session.id,
        unread: unread.length,
      });
      yield* Effect.forEach(unread, ({ onDelivery }) => onDelivery(Option.none()), {
        discard: true,
      });
    }),
  );

  /**
   * Returns `message`, or keeps it as the idle report under operator supervision.
   * `limitPassed` marks an answer whose wait limit passed.
   */
  const finish = Effect.fn("SessionConversation.finish")(function* (
    message: string,
    limitPassed = false,
  ) {
    yield* Effect.annotateCurrentSpan({ sessionId: session.id });
    if (yield* channel.isTerminal) return;
    // The answer replies to the operator if no tool call started after the last operator input.
    const calls = yield* channel.toolCalls;
    const { held, paused, operatorInput } = yield* Ref.get(state);
    const answeredOperator = Option.exists(operatorInput, (at) => at === calls);
    if (held || paused) {
      yield* Ref.update(state, (current) => ({
        ...current,
        answer: Option.some(Answer.Idle({ message, limitPassed })),
      }));
      yield* channel.emit(
        SessionIdle.make({ session, message: Option.some(message), answeredOperator }),
      );
      yield* Effect.logInfo("Session is idle under operator supervision", {
        sessionId: session.id,
        held,
        paused,
        answeredOperator,
      });
      return;
    }
    yield* Ref.update(state, (current) => ({ ...current, closing: true }));
    yield* options.beforeFinish.pipe(Effect.tapError(channel.fail));
    yield* channel.finish(session, message, answeredOperator, limitPassed);
  });

  /**
   * The wait for background work after an answer, or `None` for no limit. The limit is kept in
   * memory, so a session that was already waiting when the orchestrator restarted has none.
   */
  const backgroundWaitLimit = Option.map(options.maxBackgroundWaitMinutes, Duration.minutes);
  const limitText = Option.match(backgroundWaitLimit, {
    onNone: () => "none",
    onSome: Duration.format,
  });
  /** Holds the timer that ends a wait for background work at its limit. */
  const backgroundWait = yield* FiberHandle.make<void>();
  /** Holds the timer that ends a wait for background work that ended without a turn. */
  const backgroundGrace = yield* FiberHandle.make<void>();
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
   * restart. Each timer runs this and clears only the other timer.
   */
  const endWait = Effect.fn("SessionConversation.endWait")(function* (timer: "limit" | "grace") {
    yield* Effect.annotateCurrentSpan({ sessionId: session.id, endedBy: timer });
    const { answer, held, paused, background } = yield* Ref.get(state);
    const waiting = Option.filter(answer, Answer.$is("Waiting"));
    if (Option.isNone(waiting)) return;
    yield* FiberHandle.clear(timer === "limit" ? backgroundGrace : backgroundWait);
    const { message } = waiting.value;
    const limitPassed = timer === "limit" && !Option.exists(background, Arr.isReadonlyArrayEmpty);
    const { why } = waitEnded(limitPassed);
    const fields = {
      ...(yield* backgroundFields),
      endedBy: timer,
      grace: Duration.format(BACKGROUND_TURN_GRACE),
    };
    if (held || paused) {
      yield* Ref.update(state, (current) => ({
        ...current,
        answer: Option.some(Answer.Kept({ message, limitPassed })),
      }));
      yield* Effect.logInfo(
        `${why}; the operator's Hold or pause keeps its answer until a Release`,
        fields,
      );
      return;
    }
    yield* Ref.update(state, (current) => ({ ...current, answer: Option.none() }));
    yield* (limitPassed ? Effect.logWarning : Effect.logInfo)(
      `${why}; returning its answer`,
      fields,
    );
    yield* finish(message, limitPassed);
  }, mutex.withPermits(1));

  /**
   * Waits for background work after `answer`. With a configured limit, returns `answer` once the
   * limit passes. If the operator holds the session when the wait ends, a Release returns `answer`
   * instead, and a paused session stays open until the operator's next message. The caller holds
   * the mutex.
   */
  const awaitBackgroundWork = Effect.fn("SessionConversation.awaitBackgroundWork")(function* (
    answer: string,
  ) {
    yield* Effect.annotateCurrentSpan({ sessionId: session.id });
    yield* Ref.update(state, (current) => ({
      ...current,
      answer: Option.some(Answer.Waiting({ message: answer })),
    }));
    yield* Effect.flatMap(backgroundFields, (fields) =>
      Effect.logInfo("Session is waiting for its background work", fields),
    );
    if (Option.isNone(backgroundWaitLimit)) return;
    yield* FiberHandle.run(
      backgroundWait,
      Effect.sleep(backgroundWaitLimit.value).pipe(Effect.andThen(endWait("limit"))),
    );
  });

  /**
   * Ends the wait for background work and logs `reason` if a timer ran. A started turn also drops
   * the answer that an ended wait kept for a Release; a process restart keeps it, so that the
   * recovery reports it. The caller holds the mutex.
   */
  const cancelWait = Effect.fn("SessionConversation.cancelWait")(function* (
    reason: "turn started" | "process restarted",
  ) {
    yield* Effect.annotateCurrentSpan({ sessionId: session.id });
    const grace = yield* FiberHandle.get(backgroundGrace);
    yield* FiberHandle.clear(backgroundWait);
    yield* FiberHandle.clear(backgroundGrace);
    const { answer } = yield* Ref.getAndUpdate(state, (current) => ({
      ...current,
      answer: Option.filter(
        current.answer,
        ({ _tag }) => _tag === "Idle" || (_tag === "Kept" && reason === "process restarted"),
      ),
    }));
    if (Option.isNone(answer)) return;
    const fields = { ...(yield* backgroundFields), reason };
    yield* Answer.$match(answer.value, {
      // A timer that ends the wait replaces `Waiting` under the mutex, so a wait here has live timers.
      Waiting: () =>
        Effect.gen(function* () {
          if (Option.isSome(backgroundWaitLimit))
            yield* Effect.logInfo(
              "Session cancelled the wait limit for its background work",
              fields,
            );
          if (Option.isSome(grace))
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
    if (!Option.exists(previous.answer, Answer.$is("Waiting"))) return;
    const grace = yield* FiberHandle.get(backgroundGrace);
    if (Option.exists(work, Arr.isReadonlyArrayEmpty)) {
      if (Option.isSome(grace)) return;
      yield* FiberHandle.run(
        backgroundGrace,
        Effect.sleep(BACKGROUND_TURN_GRACE).pipe(Effect.andThen(endWait("grace"))),
      );
      yield* Effect.logInfo(
        "Session's background work ended; it returns its answer unless a turn starts within the grace period",
        { ...(yield* backgroundFields), grace: Duration.format(BACKGROUND_TURN_GRACE) },
      );
      return;
    }
    if (Option.isNone(grace)) return;
    yield* FiberHandle.clear(backgroundGrace);
    yield* Effect.flatMap(backgroundFields, (fields) =>
      Effect.logInfo("Session's background work runs again; it keeps waiting for the work", fields),
    );
  });

  /** Ends a takeover: returns the idle report, or the kept answer, unless the session is paused. */
  const release = Effect.gen(function* () {
    const current = yield* Ref.updateAndGet(state, (latest) => ({ ...latest, held: false }));
    if (current.paused || Option.isNone(current.answer)) return "read" as const;
    yield* Answer.$match(current.answer.value, {
      Waiting: () => Effect.void,
      Idle: ({ message, limitPassed }) => finish(message, limitPassed),
      Kept: ({ message, limitPassed }) =>
        Ref.update(state, (latest) => ({ ...latest, answer: Option.none() })).pipe(
          Effect.andThen(
            Effect.logInfo(
              `The operator released the session; returning ${waitEnded(limitPassed).kept}`,
              { sessionId: session.id },
            ),
          ),
          Effect.andThen(finish(message, limitPassed)),
        ),
    });
    return "read" as const;
  });

  /** Pauses the session at the harness's next boundary. */
  const interrupt = Effect.gen(function* () {
    const pausing = yield* Ref.modify(state, (current) => [
      !current.paused,
      { ...current, paused: true },
    ]);
    if (pausing)
      yield* options.pause.pipe(
        Effect.onError(() => Ref.update(state, (current) => ({ ...current, paused: false }))),
      );
    return "read" as const;
  });

  /**
   * Sends an operator message or steer. A stopped session first sends the restored messages that
   * this process hasn't sent, then starts its turn with `action`.
   */
  const message = Effect.fn("SessionConversation.message")(function* (
    action: Steer | OperatorMessage,
    onDelivery: OnDelivery,
  ) {
    const before = yield* Ref.get(state);
    const idle = Option.exists(before.answer, Answer.$is("Idle"));
    const stopped = idle || before.paused;
    const replayed = stopped ? before.inbox.unread.filter(({ sent }) => !sent) : [];
    for (const [index, unsent] of replayed.entries()) {
      const activity = index === 0 && idle ? "idle" : "running";
      const replayTaken = yield* options.send(unsent.message, activity, unsent.id);
      yield* took(unsent.id, replayTaken);
    }
    // Completion takes the same lock, so an accepted message sets the Hold before a running turn
    // can return; a rejected message changes no state.
    const taken = yield* options.send(
      action.message,
      replayed.length === 0 && idle ? "idle" : "running",
      action.id,
    );
    if (taken === "read") yield* readOperatorInput;
    const next = yield* Deferred.make<void>();
    const previous = yield* Ref.modify(state, (current) => [
      current,
      {
        ...current,
        held: action._tag === "OperatorMessage" || current.held,
        paused: false,
        // The turn replaces an idle report or a kept answer; an answer that waits keeps its timers.
        answer: Option.filter(current.answer, Answer.$is("Waiting")),
        resume: next,
      },
    ]);
    const dropped = Option.filter(previous.answer, Answer.$is("Kept"));
    if (Option.isSome(dropped))
      yield* Effect.logInfo(
        `The operator's input starts a turn; dropping ${waitEnded(dropped.value.limitPassed).kept}`,
        { sessionId: session.id },
      );
    yield* Deferred.succeed(previous.resume, undefined);
    if (taken !== "read") {
      const queuedAfter = yield* channel.toolResults;
      yield* updateInbox((inbox) => ({
        ...inbox,
        unread: [
          ...inbox.unread,
          {
            id: action.id,
            message: action.message,
            onDelivery,
            queuedAfter,
            sent: true,
            turnStart: Option.none(),
          },
        ],
      }));
      yield* took(action.id, taken);
    }
    if (stopped) yield* channel.emit(SessionResumed.make({ session }));
    if (taken === "read")
      yield* channel.emit(OperatorMessageRead.make({ session, messageId: action.id }));
    return taken;
  });

  const intervene = Effect.fn("SessionConversation.intervene")(function* (
    action: OperatorAction,
    onDelivery: OnDelivery,
  ) {
    yield* Effect.annotateCurrentSpan({ sessionId: session.id, action: action._tag });
    if (yield* channel.isTerminal) {
      return yield* SessionOperationError.make({
        operation: "steer",
        sessionId: Option.some(session.id),
        message: "This session has already returned",
        cause: new Error("session closed"),
      });
    }
    const taken: MessageTaken =
      action._tag === "Release"
        ? yield* release
        : action._tag === "Interrupt"
          ? yield* interrupt
          : yield* message(action, onDelivery);
    const { held, paused } = yield* Ref.get(state);
    yield* Effect.logInfo("Session intervention applied", {
      sessionId: session.id,
      action: action._tag,
      held,
      paused,
      queued: taken !== "read",
    });
    return InterventionState.make({ held, paused, queued: taken !== "read" });
  }, mutex.withPermits(1));

  if (Option.isSome(restored.idle) && restored.idleAnsweredOperator) {
    yield* Ref.update(state, (current) => ({ ...current, operatorInput: Option.some(restoredAt) }));
    yield* Effect.logInfo("The restored idle report replies to the operator", {
      sessionId: session.id,
    });
  }
  if (Option.isSome(restored.idle)) yield* finish(restored.idle.value);
  else if (restored.paused) yield* finish("Session paused before restart");

  return {
    /**
     * Returns `message`, the answer of the session's last turn, or keeps it as the idle report
     * under operator supervision. While the latest snapshot lists background work, the session
     * first waits for that work, up to the configured limit: until the work starts a turn, or until
     * a snapshot lists none and no turn starts within `BACKGROUND_TURN_GRACE`.
     */
    finish: (message: string) =>
      mutex.withPermits(1)(
        Effect.flatMap(Ref.get(state), ({ background }) =>
          Option.exists(background, Arr.isReadonlyArrayNonEmpty)
            ? awaitBackgroundWork(message)
            : finish(message),
        ),
      ),
    /**
     * Records a snapshot of the session's background work that replaces the previous one: every
     * piece of work that runs, or `None` if the harness doesn't report it.
     */
    reportBackground: (work: Option.Option<ReadonlyArray<BackgroundWork>>) =>
      reportBackground(work).pipe(mutex.withPermits(1)),
    /**
     * Records that the session started a turn: ends the wait for its background work and drops the
     * answer that an ended wait kept for a Release.
     */
    turnStarted: mutex.withPermits(1)(cancelWait("turn started")),
    /**
     * Records that the session's turn ended: drops the session's own inputs that the harness didn't
     * record, because each belongs to the turn that it started.
     */
    turnEnded: mutex.withPermits(1)(turnEnded()),
    /**
     * Records that the harness process restarted: ends the wait for its background work, keeps the
     * answer that an ended wait kept for the recovery, and records the work as not reported until
     * the new process reports it.
     */
    processRestarted: mutex.withPermits(1)(
      cancelWait("process restarted").pipe(
        Effect.andThen(Ref.get(state)),
        Effect.flatMap(({ background }) =>
          Option.isSome(background) ? reportBackground(Option.none()) : Effect.void,
        ),
      ),
    ),
    intervene,
    /**
     * Sends the session's own input `message`, such as its task, with `send`, which starts a turn.
     * The harness's record of it in that turn then reads no operator message with the same text.
     * Holds the conversation's lock while it sends, so no receipt or turn end comes between.
     */
    sendOwn: <A, E>(message: string, send: (message: string) => Effect.Effect<A, E>) =>
      mutex.withPermits(1)(sendOwn(message, send)),
    recover: Effect.fn("SessionConversation.recover")(function* (
      tools: ReadonlyArray<InterruptedTool>,
      send: (
        message: string,
        id?: OperatorMessageId,
      ) => Effect.Effect<MessageTaken, AgentSessionError>,
      empty: boolean = false,
    ) {
      yield* Effect.annotateCurrentSpan({ sessionId: session.id });
      if (yield* channel.isTerminal)
        return yield* Effect.logInfo("Skipping continuation of a terminal child", {
          sessionId: session.id,
        });
      const before = yield* Ref.get(state);
      const kept = Option.filter(before.answer, Answer.$is("Kept"));
      // A child without its task gets it under supervision, so it doesn't stop first. The idle
      // report that `finish` keeps replaces the kept answer.
      if (
        (before.held || before.paused) &&
        !Option.exists(before.answer, Answer.$is("Idle")) &&
        !empty
      ) {
        if (Option.isSome(kept)) {
          const { message, limitPassed } = kept.value;
          yield* Effect.logInfo(`The recovered session reports ${waitEnded(limitPassed).kept}`, {
            sessionId: session.id,
            held: before.held,
            paused: before.paused,
          });
          yield* finish(message, limitPassed);
        } else yield* finish("Session interrupted before its turn returned");
      }
      // A new native process has read none of the queued messages and records none of the earlier
      // process's own inputs.
      const recovering = yield* Ref.updateAndGet(state, (current) => ({
        ...current,
        inbox: {
          ...current.inbox,
          unread: current.inbox.unread.map((queued) => ({
            ...queued,
            sent: false,
            turnStart: Option.none(),
          })),
          own: [],
        },
      }));
      /** Records the harness's own input: it resumes an idle session and doesn't reply to the operator. */
      const ownInput = Effect.gen(function* () {
        const current = yield* Ref.getAndUpdate(state, (latest) => ({
          ...latest,
          answer: Option.filter(latest.answer, Predicate.not(Answer.$is("Idle"))),
          operatorInput: Option.none(),
        }));
        if (Option.exists(current.answer, Answer.$is("Idle")))
          yield* channel.emit(SessionResumed.make({ session }));
        if (Option.isSome(current.operatorInput))
          yield* Effect.logInfo(
            "The harness sent its own continuation input; the next answer no longer replies to the operator",
            { sessionId: session.id },
          );
      });
      yield* policy.recover(
        {
          held: recovering.held,
          paused: recovering.paused,
          idle: Option.exists(recovering.answer, Answer.$is("Idle")),
          empty,
        },
        tools,
        recovering.inbox.unread.map(({ id, message }) => ({ id, message })),
        channel.emit,
        (message, id) =>
          id === undefined
            ? sendOwn(message, send).pipe(Effect.andThen(ownInput))
            : send(message, id).pipe(Effect.flatMap((taken) => took(id, taken))),
      );
    }, mutex.withPermits(1)),
    /**
     * Applies what the harness signal `signal` says about the operator messages that the session
     * read. Returns the IDs of the messages that it acknowledged, oldest first, and how many native
     * records it repeated.
     */
    observe: (signal: S) =>
      mutex.withPermits(1)(
        Effect.forEach(options.decode(signal), receive).pipe(
          Effect.map((results) => ({
            read: results.flatMap(({ read }) => read),
            repeated: results.reduce((sum, { repeated }) => sum + repeated, 0),
          })),
        ),
      ),
    /** Waits until the session is not paused; harness hooks run it before each tool call or model request. */
    awaitUnpaused: Effect.flatMap(Ref.get(state), (current) =>
      current.paused ? Deferred.await(current.resume) : Effect.void,
    ),
    isPaused: Effect.map(Ref.get(state), ({ paused }) => paused),
    /** Whether the session finished a turn and waits under operator supervision. */
    isIdle: Effect.map(Ref.get(state), ({ answer }) => Option.exists(answer, Answer.$is("Idle"))),
    isClosing: Effect.map(Ref.get(state), ({ closing }) => closing),
    /** The queued operator messages that the harness hasn't read, oldest first. */
    unread: Effect.map(Ref.get(state), ({ inbox }) =>
      inbox.unread.map(({ id, message }) => ({ id, message })),
    ),
  };
});
