import {
  type AgentSession,
  type BackgroundWork,
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
import { Array as Arr, Deferred, Effect, Fiber, Option, Predicate, Ref, Semaphore } from "effect";
import {
  type AgentSessionError,
  type InterruptedTool,
  type OnDelivery,
  SessionOperationError,
} from "../../runtime.ts";
import type { ContinuationPolicy } from "../continuation.ts";
import {
  advanceTurn,
  type Inbox,
  match,
  Receipt,
  type ReadPoint,
  resetProcess,
  type Unread,
} from "../receipts.ts";
import type { SessionChannel } from "../session.ts";
import { Answer, backgroundWait, type WaitState, type WaitTimer, waitEnded } from "./background.ts";

/**
 * How the harness accepted an operator message or own input: `read` if it starts the next turn of
 * an idle session or joins the running turn immediately, `queued` if the harness reads it at its
 * next boundary in the running turn, `next-turn` if no turn runs and the harness reads it when the
 * next turn starts (before that turn's tool calls), and `after-turn` if a turn is ending and the
 * harness holds the input until `turnEnded` before sending it to the next turn.
 */
export type MessageTaken = "read" | "queued" | "next-turn" | "after-turn";

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

/** An operator message that the harness hasn't read, and what to run when it is read or not. */
interface QueuedMessage extends Unread {
  readonly onDelivery: OnDelivery;
}

/** The supervision of one conversation and the operator input that its session read. */
interface ConversationState extends WaitState {
  /** Whether the session's last report was `SessionIdle`, which a `SessionResumed` ends. */
  readonly idleReported: boolean;
  /**
   * The session's tool-call count when it last read an operator message or steer, or `None` after
   * its own input, such as a continuation turn.
   */
  readonly operatorInput: Option.Option<number>;
  readonly closing: boolean;
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
  const scope = yield* Effect.scope;
  const restoredAt = yield* channel.toolCalls;
  const restoredAfter = yield* channel.toolResults;
  const submitted = options.submitted ?? [];
  const resume = yield* Deferred.make<void>();
  const state = yield* Ref.make<ConversationState>({
    held: restored.held,
    paused: restored.paused,
    answer: Option.none(),
    idleReported: false,
    operatorInput: Option.none(),
    closing: false,
    background: Option.none(),
    resume,
    inbox: {
      unread: restored.unread.map((message) => ({
        ...message,
        onDelivery: (delivered) => journal.delivered(message.id, delivered),
        queuedAfter: restoredAfter,
        delivery: submitted.includes(message.id) ? ("sent" as const) : ("unsent" as const),
        turnStart: Option.none(),
      })),
      own: [],
      nextOwn: [],
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
   * Records how the harness took queued message `id`: a read is reported now, a message for the
   * next turn notes where that turn starts, and an `after-turn` message waits until `turnEnded`
   * before live receipts can match it. The caller holds the mutex.
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
                delivery: taken === "after-turn" ? ("after-turn" as const) : ("sent" as const),
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
      if (taken === "after-turn")
        yield* Effect.logInfo(
          "The harness holds the operator message until the current turn ends",
          { sessionId: session.id },
        );
    });

  /**
   * Sends the session's own input `message`, such as its task, with `send`, which starts a turn,
   * joins the running one, or holds the input (`after-turn`) for the turn after the running one.
   * The harness's record of it in that turn then reads no operator message with the same text, and
   * an `after-turn` input stays separate until `turnEnded` so a delayed receipt of the ending turn
   * never consumes it. If `send` fails, `message` stays an own input until a turn ends or a
   * process restart clears the own inputs. The caller holds the mutex.
   */
  const sendOwn = <A extends MessageTaken | void, E>(
    message: string,
    send: (message: string) => Effect.Effect<A, E>,
  ) =>
    send(message).pipe(
      Effect.tap((taken) =>
        updateInbox((inbox) =>
          taken === "after-turn"
            ? { ...inbox, nextOwn: [...inbox.nextOwn, message] }
            : { ...inbox, own: [...inbox.own, message] },
        ),
      ),
      Effect.onError(() => updateInbox((inbox) => ({ ...inbox, own: [...inbox.own, message] }))),
    );

  const turnEnded = Effect.fn("SessionConversation.turnEnded")(function* () {
    yield* Effect.annotateCurrentSpan({ sessionId: session.id });
    const { dropped, kept, promoted } = yield* Ref.modify(state, (current) => {
      const next = advanceTurn(current.inbox);
      return [next, { ...current, inbox: next.inbox }];
    });
    if (dropped > 0)
      yield* Effect.logInfo(
        "The turn ended without the harness's record of the session's own input; dropping it",
        { sessionId: session.id, dropped },
      );
    if (kept > 0)
      yield* Effect.logInfo(
        "The harness held the session's own input for its next turn; activating it after the turn end",
        { sessionId: session.id, kept },
      );
    if (promoted > 0)
      yield* Effect.logInfo(
        "The harness held operator messages for its next turn; activating them after the turn end",
        { sessionId: session.id, promoted },
      );
  });

  function endTurn(): Effect.Effect<void>;
  function endTurn<A, E>(after: Effect.Effect<A, E>): Effect.Effect<A, E>;
  function endTurn<A, E>(after?: Effect.Effect<A, E>): Effect.Effect<A | void, E> {
    return mutex.withPermits(1)(turnEnded().pipe(Effect.andThen(after ?? Effect.void)));
  }

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
   * Applies `f` to the conversation state and returns the state before it. Every change of the
   * answer goes through here, except a change of a waiting answer's timers: a `Waiting` answer that
   * `f` replaces or drops stops its timers, except `running`, the timer that ends that wait and
   * calls this. The caller holds the mutex.
   */
  const transition = (f: (current: ConversationState) => ConversationState, running?: WaitTimer) =>
    Effect.gen(function* () {
      const [previous, next] = yield* Ref.modify(state, (current) => {
        const updated = f(current);
        return [[current, updated] as const, updated];
      });
      const replaced = Option.filter(
        Option.filter(previous.answer, Answer.$is("Waiting")),
        (waiting) => !Option.exists(next.answer, (answer) => answer === waiting),
      );
      if (Option.isNone(replaced)) return previous;
      const { timers } = replaced.value;
      yield* Fiber.interruptAll(
        Arr.getSomes(
          (["limit", "grace"] as const)
            .filter((timer) => timer !== running)
            .map((timer) => timers[timer]),
        ),
      );
      // A dropped wait, or one that its own timer ends, logs why where it ends.
      if (running === undefined && (Option.isSome(next.answer) || next.closing))
        yield* Effect.logInfo(
          next.closing
            ? "A later final answer cancels the previous wait for background work"
            : "A later answer replaces the answer that waits for background work; stopping its wait",
          {
            sessionId: session.id,
            replacedBy: Option.match(next.answer, {
              onNone: () => "Final",
              onSome: ({ _tag }) => _tag,
            }),
            limit: Option.isSome(timers.limit),
            grace: Option.isSome(timers.grace),
          },
        );
      return previous;
    });

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
      yield* transition((current) => ({
        ...current,
        answer: Option.some(Answer.Idle({ message, limitPassed })),
        idleReported: true,
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
    yield* transition((current) => ({ ...current, answer: Option.none(), closing: true }));
    yield* options.beforeFinish.pipe(Effect.tapError(channel.fail));
    yield* channel.finish(session, message, answeredOperator, limitPassed);
  });

  const { awaitBackgroundWork, cancelWait, reportBackground } = backgroundWait({
    session,
    channel,
    state,
    mutex,
    scope,
    transition,
    finish,
    maxBackgroundWaitMinutes: options.maxBackgroundWaitMinutes,
  });

  /** Ends a takeover: returns the idle report, or the kept answer, unless the session is paused. */
  const release = Effect.gen(function* () {
    const current = yield* Ref.updateAndGet(state, (latest) => ({ ...latest, held: false }));
    if (current.paused || Option.isNone(current.answer)) return "read" as const;
    yield* Answer.$match(current.answer.value, {
      Waiting: () => Effect.void,
      Idle: ({ message, limitPassed }) => finish(message, limitPassed),
      Kept: ({ message, limitPassed }) =>
        transition((latest) => ({ ...latest, answer: Option.none() })).pipe(
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
   * this process hasn't sent, then starts its turn with `action`. The session resumes if it was
   * stopped or last reported idle, even if a later answer, such as one that waits for background
   * work, replaced its idle report.
   */
  const message = Effect.fn("SessionConversation.message")(function* (
    action: Steer | OperatorMessage,
    onDelivery: OnDelivery,
  ) {
    const before = yield* Ref.get(state);
    const idle = Option.exists(before.answer, Answer.$is("Idle"));
    const stopped = idle || before.paused;
    const replayed = stopped
      ? before.inbox.unread.filter(({ delivery }) => delivery === "unsent")
      : [];
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
    const previous = yield* transition((current) => ({
      ...current,
      held: action._tag === "OperatorMessage" || current.held,
      paused: false,
      // The turn replaces an idle report or a kept answer; an answer that waits keeps its timers.
      answer: Option.filter(current.answer, Answer.$is("Waiting")),
      idleReported: false,
      resume: next,
    }));
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
            delivery: taken === "after-turn" ? ("after-turn" as const) : ("sent" as const),
            turnStart: Option.none(),
          },
        ],
      }));
      yield* took(action.id, taken);
    }
    if (stopped || previous.idleReported) yield* channel.emit(SessionResumed.make({ session }));
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
     * first waits for that work, up to the configured limit: until the work starts a turn, or until
     * a snapshot lists none and no turn starts within `BACKGROUND_TURN_GRACE`.
     */
    finish: (message: string) => mutex.withPermits(1)(answer(message)),
    /**
     * Returns `message` as `finish` does, unless `unread` counts input that the harness hasn't
     * read or that started a turn since `message`. `unread` runs under the conversation's lock, so
     * it counts an operator message that was being sent. That input starts another turn, whose
     * answer the session returns instead.
     */
    finishUnlessUnread: (message: string, unread: Effect.Effect<number>) =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          const count = yield* unread;
          if (count === 0) return yield* answer(message);
          yield* Effect.logInfo(
            "Session answered with input that starts another turn; waiting for that turn",
            { sessionId: session.id, unread: count },
          );
        }),
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
     * record, activates any inputs held with `after-turn` for the next turn, and optionally runs
     * `after` under the same lock so the adapter updates its turn state atomically.
     */
    turnEnded: endTurn,
    /**
     * Records that the harness process restarted: ends the wait for its background work, keeps the
     * answer that an ended wait kept for the recovery, clears the earlier process's own inputs and
     * marks queued operator messages unsent for the new process, and records the work as not
     * reported until the new process reports it.
     */
    processRestarted: mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* cancelWait("process restarted");
        const { droppedOwn, droppedNextOwn, reset } = yield* Ref.modify(state, (current) => {
          const next = resetProcess(current.inbox);
          return [next, { ...current, inbox: next.inbox }];
        });
        if (droppedOwn > 0 || droppedNextOwn > 0 || reset > 0)
          yield* Effect.logInfo("Reset process-bound conversation inbox after restart", {
            sessionId: session.id,
            droppedOwn,
            droppedNextOwn,
            reset,
          });
        const { background } = yield* Ref.get(state);
        if (Option.isSome(background)) yield* reportBackground(Option.none());
      }),
    ),
    intervene,
    /**
     * Sends the session's own input `message`, such as its task, with `send`, which starts a turn,
     * joins the running one, or holds the input (`after-turn`) for the turn after the running one.
     * The harness's record of it in that turn then reads no operator message with the same text.
     * Holds the conversation's lock while it sends: a receipt that is saving when the send starts
     * can't write back an inbox without `message`, and a turn end that arrives during the send
     * activates `message` if `send` returned `after-turn`.
     */
    sendOwn: <A extends MessageTaken | void, E>(
      message: string,
      send: (message: string) => Effect.Effect<A, E>,
    ) => mutex.withPermits(1)(sendOwn(message, send)),
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
      const recovering = yield* Ref.get(state);
      /**
       * Records the harness's own input: it resumes a session that last reported idle and doesn't
       * reply to the operator.
       */
      const ownInput = Effect.gen(function* () {
        const current = yield* transition((latest) => ({
          ...latest,
          answer: Option.filter(latest.answer, Predicate.not(Answer.$is("Idle"))),
          idleReported: false,
          operatorInput: Option.none(),
        }));
        if (current.idleReported) yield* channel.emit(SessionResumed.make({ session }));
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
        recovering.inbox.unread
          .filter(({ delivery }) => delivery === "unsent")
          .map(({ id, message }) => ({ id, message })),
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
