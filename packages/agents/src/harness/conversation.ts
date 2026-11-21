import {
  type AgentSession,
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
import { Deferred, Effect, Option, Ref, Semaphore } from "effect";
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
    resume,
    inbox: {
      unread: restored.unread.map((message) => ({
        ...message,
        onDelivery: (delivered) => journal.delivered(message.id, delivered),
        queuedAfter: restoredAfter,
        sent: submitted.includes(message.id),
        turnStart: Option.none(),
      })),
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
    return { read: matched.read.length, repeated: Option.isSome(matched.repeated) ? 1 : 0 };
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

  return {
    finish: (message: string) => mutex.withPermits(1)(finish(message)),
    /**
     * Runs `announce` and then finishes with `message`, an answer whose wait limit passed, if the
     * session is neither held nor paused. Otherwise keeps `message`, without reporting the session
     * idle, for a later Release or for the recovery after a process resume, and returns `false`.
     */
    finishOverdue: (message: string, announce: Effect.Effect<void>) =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          const { held, paused } = yield* Ref.get(state);
          if (!held && !paused) {
            yield* announce;
            yield* finish(message, true);
            return true;
          }
          yield* Ref.update(state, (current) => ({ ...current, overdue: Option.some(message) }));
          return false;
        }),
      ),
    /** Drops the answer that `finishOverdue` kept, if any, and returns whether one was kept. */
    dropOverdue: Effect.flatMap(Ref.get(state), ({ overdue }) =>
      Option.isNone(overdue)
        ? Effect.succeed(false)
        : mutex.withPermits(1)(
            Ref.modify(state, (current) => [
              Option.isSome(current.overdue),
              { ...current, overdue: Option.none() },
            ]),
          ),
    ),
    intervene,
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
      // A new native process has read none of the queued messages.
      const recovering = yield* Ref.updateAndGet(state, (current) => ({
        ...current,
        inbox: {
          ...current.inbox,
          unread: current.inbox.unread.map((queued) => ({
            ...queued,
            sent: false,
            turnStart: Option.none(),
          })),
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
          send(message, id).pipe(
            Effect.flatMap((taken) => (id === undefined ? ownInput : took(id, taken))),
          ),
      );
    }, mutex.withPermits(1)),
    /**
     * Applies what the harness signal `signal` says about the operator messages that the session
     * read. Returns how many messages it acknowledged and how many native records it repeated.
     */
    observe: (signal: S) =>
      mutex.withPermits(1)(
        Effect.forEach(options.decode(signal), receive).pipe(
          Effect.map((results) => ({
            read: results.reduce((sum, { read }) => sum + read, 0),
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
