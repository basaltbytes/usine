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
  Deferred,
  Duration,
  Effect,
  Equal,
  FiberHandle,
  Option,
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
   * The minutes that a session that answered waits for its background work to start a turn, or
   * `None` for no limit.
   */
  readonly maxBackgroundWaitMinutes: Option.Option<number>;
}

/** An operator message that the harness hasn't read, and what to run when it is read or not. */
interface QueuedMessage extends Unread {
  readonly onDelivery: OnDelivery;
}

/** The supervision of one conversation and the operator input that its session read. */
interface ConversationState {
  readonly held: boolean;
  readonly paused: boolean;
  /** The report that the session keeps while it waits idle under operator supervision. */
  readonly idle: Option.Option<string>;
  /** Whether `idle` is an answer whose wait limit passed. */
  readonly idleLimitPassed: boolean;
  /**
   * An answer whose wait limit passed while the operator supervised the session. A Release returns
   * it unless a turn starts first.
   */
  readonly overdue: Option.Option<string>;
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
 * lists work waits for that work to start a turn, up to `maxBackgroundWaitMinutes`.
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
    idle: Option.none(),
    idleLimitPassed: false,
    overdue: Option.none(),
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
   * Sends the session's own input `message`, such as its task, with `send`. The harness's record
   * of it then reads no operator message with the same text. If `send` fails, `message` stays an
   * own input until `recover` clears the own inputs.
   */
  const sendOwn = <A, E>(message: string, send: (message: string) => Effect.Effect<A, E>) =>
    updateInbox((inbox) => ({ ...inbox, own: [...inbox.own, message] })).pipe(
      Effect.andThen(send(message)),
    );

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
        idle: Option.some(message),
        idleLimitPassed: limitPassed,
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
  /** Holds the timer that ends a wait for background work after the session answered. */
  const backgroundWait = yield* FiberHandle.make<void>();
  /** The log fields that name the session's background work and the wait limit. */
  const backgroundFields = Effect.map(Ref.get(state), ({ background }) => ({
    sessionId: session.id,
    backgroundWorkIds: Option.getOrUndefined(
      Option.map(background, (work) => work.map(({ id }) => id)),
    ),
    limit: limitText,
  }));

  /**
   * Finishes with `message`, an answer whose wait limit passed, if the session is neither held nor
   * paused. Otherwise keeps `message`, without reporting the session idle, for a later Release or
   * for the recovery after a process restart.
   */
  const finishOverdue = (message: string) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const { held, paused } = yield* Ref.get(state);
        const fields = yield* backgroundFields;
        if (!held && !paused) {
          yield* Effect.logWarning(
            "Session's background work outlasted the wait limit; returning its answer",
            fields,
          );
          yield* finish(message, true);
          return;
        }
        yield* Ref.update(state, (current) => ({ ...current, overdue: Option.some(message) }));
        yield* Effect.logInfo(
          "Session's background work outlasted the wait limit; the operator's Hold or pause keeps it open until a Release",
          fields,
        );
      }),
    );

  /** Drops the answer that `finishOverdue` kept, if any, and returns whether one was kept. */
  const dropOverdue = Effect.flatMap(Ref.get(state), ({ overdue }) =>
    Option.isNone(overdue)
      ? Effect.succeed(false)
      : mutex.withPermits(1)(
          Ref.modify(state, (current) => [
            Option.isSome(current.overdue),
            { ...current, overdue: Option.none() },
          ]),
        ),
  );

  /**
   * Waits for background work after `answer`. With a configured limit, returns `answer` once the
   * limit passes; if the operator holds the session then, a Release returns `answer` instead, and
   * a paused session stays open until the operator's next message.
   */
  const awaitBackgroundWork = Effect.fn("SessionConversation.awaitBackgroundWork")(function* (
    answer: string,
  ) {
    yield* Effect.annotateCurrentSpan({ sessionId: session.id });
    yield* Effect.flatMap(backgroundFields, (fields) =>
      Effect.logInfo("Session is waiting for its background work", fields),
    );
    if (Option.isNone(backgroundWaitLimit)) return;
    yield* FiberHandle.run(
      backgroundWait,
      Effect.sleep(backgroundWaitLimit.value).pipe(Effect.andThen(finishOverdue(answer))),
    );
  });

  /**
   * Cancels the running wait limit and logs `reason` if a wait ran. A started turn also drops the
   * answer that a passed limit kept for a Release; a process restart keeps it, so that the
   * recovery reports it.
   */
  const cancelWait = Effect.fn("SessionConversation.cancelWait")(function* (
    reason: "turn started" | "process restarted",
  ) {
    const wait = yield* FiberHandle.get(backgroundWait);
    if (Option.isSome(wait)) yield* FiberHandle.clear(backgroundWait);
    const dropped = reason === "turn started" && (yield* dropOverdue);
    if (Option.isNone(wait) && !dropped) return;
    yield* Effect.annotateCurrentSpan({ sessionId: session.id });
    yield* Effect.logInfo("Session cancelled the wait limit for its background work", {
      ...(yield* backgroundFields),
      reason,
      limitPassed: dropped,
    });
  });

  /** Records `work` as the latest snapshot and reports it if it changed. */
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
  });

  /** Ends a takeover: returns the idle report, or the overdue answer, unless the session is paused. */
  const release = Effect.gen(function* () {
    const current = yield* Ref.updateAndGet(state, (latest) => ({ ...latest, held: false }));
    if (current.paused) return "read" as const;
    if (Option.isSome(current.idle)) yield* finish(current.idle.value, current.idleLimitPassed);
    else if (Option.isSome(current.overdue)) {
      yield* Ref.update(state, (latest) => ({ ...latest, overdue: Option.none() }));
      yield* Effect.logInfo(
        "The operator released a session whose wait limit passed; returning its answer",
        { sessionId: session.id },
      );
      yield* finish(current.overdue.value, true);
    }
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
    const stopped = Option.isSome(before.idle) || before.paused;
    const replayed = stopped ? before.inbox.unread.filter(({ sent }) => !sent) : [];
    for (const [index, unsent] of replayed.entries()) {
      const activity = index === 0 && Option.isSome(before.idle) ? "idle" : "running";
      const replayTaken = yield* options.send(unsent.message, activity, unsent.id);
      yield* took(unsent.id, replayTaken);
    }
    // Completion takes the same lock, so an accepted message sets the Hold before a running turn
    // can return; a rejected message changes no state.
    const taken = yield* options.send(
      action.message,
      replayed.length === 0 && Option.isSome(before.idle) ? "idle" : "running",
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
        idle: Option.none(),
        idleLimitPassed: false,
        overdue: Option.none(),
        resume: next,
      },
    ]);
    if (Option.isSome(previous.overdue))
      yield* Effect.logInfo("The operator's input starts a turn; dropping the overdue answer", {
        sessionId: session.id,
      });
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

  /** Returns `message`, or waits for the background work that the latest snapshot lists. */
  const answer = (message: string) =>
    Effect.flatMap(Ref.get(state), ({ background }) =>
      Option.exists(background, Arr.isReadonlyArrayNonEmpty)
        ? awaitBackgroundWork(message)
        : finish(message),
    );

  return {
    /**
     * Returns `message`, the answer of the session's last turn, or keeps it as the idle report
     * under operator supervision. While the latest snapshot lists background work, the session
     * first waits for that work to start a turn, up to the configured limit.
     */
    finish: (message: string) => mutex.withPermits(1)(answer(message)),
    /**
     * Returns `message` as `finish` does, unless `unread` counts input that the harness hasn't
     * read. `unread` runs under the conversation's lock, so it counts an operator message that was
     * being sent. That input starts another turn, whose answer the session returns instead.
     */
    finishUnlessUnread: (message: string, unread: Effect.Effect<number>) =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          const count = yield* unread;
          if (count === 0) return yield* answer(message);
          yield* Effect.logInfo(
            "Session answered with input that its harness hasn't read; waiting for the turn that the input starts",
            { sessionId: session.id, unread: count },
          );
        }),
      ),
    /**
     * Records a snapshot of the session's background work that replaces the previous one: every
     * piece of work that runs, or `None` if the harness doesn't report it.
     */
    reportBackground,
    /**
     * Records that the session started a turn: cancels the wait limit for its background work and
     * drops the answer that a passed limit kept for a Release.
     */
    turnStarted: cancelWait("turn started"),
    /**
     * Records that the harness process restarted: cancels the wait limit for its background work,
     * keeps the answer that a passed limit kept for the recovery, and records the work as not
     * reported until the new process reports it.
     */
    processRestarted: cancelWait("process restarted").pipe(
      Effect.andThen(Ref.get(state)),
      Effect.flatMap(({ background }) =>
        Option.isSome(background) ? reportBackground(Option.none()) : Effect.void,
      ),
    ),
    intervene,
    sendOwn,
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
      // A child without its task gets it under supervision, so it doesn't stop first.
      if ((before.held || before.paused) && Option.isNone(before.idle) && !empty) {
        if (Option.isSome(before.overdue)) {
          yield* Ref.update(state, (current) => ({ ...current, overdue: Option.none() }));
          yield* Effect.logInfo(
            "The recovered session reports the answer whose wait limit passed",
            { sessionId: session.id, held: before.held, paused: before.paused },
          );
          yield* finish(before.overdue.value, true);
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
          idle: Option.none(),
          operatorInput: Option.none(),
        }));
        if (Option.isSome(current.idle)) yield* channel.emit(SessionResumed.make({ session }));
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
          idle: Option.isSome(recovering.idle),
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
    isIdle: Effect.map(Ref.get(state), ({ idle }) => Option.isSome(idle)),
    isClosing: Effect.map(Ref.get(state), ({ closing }) => closing),
    /** The queued operator messages that the harness hasn't read, oldest first. */
    unread: Effect.map(Ref.get(state), ({ inbox }) =>
      inbox.unread.map(({ id, message }) => ({ id, message })),
    ),
  };
});
