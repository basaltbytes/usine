import { type AgentSession, SessionIdle, SessionResumed } from "@usine/core/agent/session";
import {
  InterventionState,
  type OperatorMessageId,
  type OperatorAction,
} from "@usine/core/attempt/channel";
import { Deferred, Effect, Option, Semaphore } from "effect";
import {
  ChildSessionJournal,
  type AgentSessionError,
  type OnDelivery,
  type QueuedOperatorMessage,
  type InterruptedTool,
  SessionOperationError,
} from "../runtime.ts";
import type { ContinuationPolicy } from "./continuation.ts";
import type { SessionChannel } from "./session.ts";

/**
 * How the harness accepted an operator message: `read` if it starts the next turn of an idle session
 * or joins the running turn immediately, `queued` if the harness reads it at its next boundary.
 */
export type MessageTaken = "read" | "queued";

/**
 * When the harness read the messages it acknowledges: `now` at the acknowledgment, a tool-call
 * count that the harness captured at the read, or `turn` when the acknowledgment ends a turn that
 * folded each message in at its first tool result after the message was queued, or at the turn's
 * end if no tool call finished since.
 */
export type ReadPoint = "now" | "turn" | number;

interface ConversationOptions {
  readonly session: AgentSession;
  readonly channel: SessionChannel;
  readonly held: boolean;
  readonly paused: boolean;
  readonly unread?: ReadonlyArray<QueuedOperatorMessage>;
  /** Restored messages already submitted to a retained native process. */
  readonly submitted?: ReadonlyArray<OperatorMessageId>;
  readonly idle: Option.Option<string>;
  /** Whether the restored idle report replies to operator input (ADR 0018). */
  readonly idleAnsweredOperator: boolean;
  /**
   * Queues a message during a turn, or starts another turn in an idle session. If it returns
   * `queued`, the harness reports the read later through `read`.
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

/** An operator message the harness queued, and the callback for when it is read or the session stops. */
interface QueuedMessage {
  readonly id: OperatorMessageId;
  readonly message: string;
  readonly onDelivery: OnDelivery;
  /** The session's count of finished tool calls when the message was queued. */
  readonly queuedAfter: number;
}

/**
 * Keeps an idle child addressable while on Hold, and keeps an interrupted session waiting until
 * guidance arrives. Queued operator messages are reported as read when the harness acknowledges their IDs,
 * and as unread if the scope closes first. The result's `answeredOperator` is true when the session
 * read an operator message or steer after its last tool call.
 */
export const sessionConversation = Effect.fn("SessionConversation.make")(function* (
  options: ConversationOptions,
) {
  const { session, channel } = options;
  const mutex = yield* Semaphore.make(1);
  let held = options.held;
  let paused = options.paused;
  let idle = Option.none<string>();
  /**
   * An answer whose wait limit passed while the operator supervised the session. A Release returns
   * it unless a turn starts first.
   */
  let overdue = Option.none<string>();
  /**
   * The session's tool-call count when it last read an operator message or steer, or `None` after
   * its own input, such as a continuation turn.
   */
  let operatorInput = Option.none<number>();
  let closing = false;
  let resume = yield* Deferred.make<void>();
  const journal = yield* ChildSessionJournal.current;
  const restoredAt = yield* channel.toolCalls;
  const restoredAfter = yield* channel.toolResults;
  const queued: Array<QueuedMessage> = (options.unread ?? []).map((message) => ({
    ...message,
    onDelivery: (state) => journal.delivered(message.id, state),
    queuedAfter: restoredAfter,
  }));

  const unsent = new Set(
    (options.unread ?? [])
      .map(({ id }) => id)
      .filter((id) => !(options.submitted ?? []).includes(id)),
  );
  const sent = (id: OperatorMessageId) =>
    Effect.sync(() => {
      unsent.delete(id);
    });

  /** Records that the session read operator input at tool-call count `count`. */
  const readOperatorInputAt = (count: number) =>
    Effect.sync(() => {
      operatorInput = Option.some(
        Option.match(operatorInput, { onNone: () => count, onSome: (at) => Math.max(at, count) }),
      );
    });
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

  /** Reports the identified messages as read at `at`, with the current session state. */
  const deliver = (ids: ReadonlyArray<OperatorMessageId>, at: ReadPoint = "now") =>
    Effect.suspend(() => {
      const read = queued.filter(({ id }) => ids.includes(id));
      for (let index = queued.length - 1; index >= 0; index -= 1) {
        const message = queued[index];
        if (message !== undefined && ids.includes(message.id)) queued.splice(index, 1);
      }
      if (read.length === 0) return Effect.void;
      const state = InterventionState.make({ held, paused });
      const readAt =
        at === "now"
          ? readOperatorInput
          : at === "turn"
            ? Effect.forEach(read, ({ queuedAfter }) => foldedAt(queuedAfter)).pipe(
                Effect.flatMap((points) => readOperatorInputAt(Math.max(...points))),
              )
            : readOperatorInputAt(at);
      return Effect.logInfo("The session read queued operator messages", {
        sessionId: session.id,
        read: read.length,
        stillQueued: queued.length,
        at,
      }).pipe(
        Effect.andThen(readAt),
        Effect.andThen(
          Effect.forEach(read, ({ onDelivery }) => onDelivery(Option.some(state)), {
            discard: true,
          }),
        ),
      );
    });

  yield* Effect.addFinalizer(() =>
    Effect.suspend(() => {
      const unread = queued.splice(0);
      if (unread.length === 0) return Effect.void;
      return Effect.logWarning("The session stopped before it read queued operator messages", {
        sessionId: session.id,
        unread: unread.length,
      }).pipe(
        Effect.andThen(
          Effect.forEach(unread, ({ onDelivery }) => onDelivery(Option.none()), {
            discard: true,
          }),
        ),
      );
    }),
  );

  const finish = Effect.fn("SessionConversation.finish")(function* (message: string) {
    yield* Effect.annotateCurrentSpan({ sessionId: session.id });
    if (yield* channel.isTerminal) return;
    // The answer replies to the operator if no tool call started after the last operator input.
    const calls = yield* channel.toolCalls;
    const answeredOperator = Option.exists(operatorInput, (at) => at === calls);
    if (held || paused) {
      idle = Option.some(message);
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
    closing = true;
    yield* options.beforeFinish.pipe(Effect.tapError(channel.fail));
    yield* channel.finish(session, message, answeredOperator);
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
    let taken: MessageTaken = "read";
    if (action._tag === "Release") {
      held = false;
      if (Option.isSome(idle) && !paused) yield* finish(idle.value);
      else if (Option.isSome(overdue) && !paused) {
        const answer = overdue.value;
        overdue = Option.none();
        yield* Effect.logInfo(
          "The operator released a session whose wait limit passed; returning its answer",
          { sessionId: session.id },
        );
        yield* finish(answer);
      }
    } else if (action._tag === "Interrupt") {
      if (!paused) {
        paused = true;
        yield* options.pause.pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              paused = false;
            }),
          ),
        );
      }
    } else {
      const stopped = Option.isSome(idle) || paused;
      let activity: "idle" | "running" = Option.isSome(idle) ? "idle" : "running";
      if (stopped) {
        for (const message of queued.slice()) {
          if (!unsent.has(message.id)) continue;
          const replayed = yield* options.send(message.message, activity, message.id);
          yield* sent(message.id);
          if (replayed === "read") yield* deliver([message.id]);
          activity = "running";
        }
      }
      // Completion takes the same lock, so an accepted message sets the Hold before a running turn
      // can return; a rejected message changes no state.
      taken = yield* options.send(action.message, activity, action.id);
      if (taken === "read") yield* readOperatorInput;
      if (action._tag === "OperatorMessage") held = true;
      paused = false;
      idle = Option.none();
      if (Option.isSome(overdue)) {
        overdue = Option.none();
        yield* Effect.logInfo("The operator's input starts a turn; dropping the overdue answer", {
          sessionId: session.id,
        });
      }
      yield* Deferred.succeed(resume, undefined);
      resume = yield* Deferred.make<void>();
      if (taken === "queued")
        queued.push({
          id: action.id,
          message: action.message,
          onDelivery,
          queuedAfter: yield* channel.toolResults,
        });
      if (stopped) yield* channel.emit(SessionResumed.make({ session }));
    }
    yield* Effect.logInfo("Session intervention applied", {
      sessionId: session.id,
      action: action._tag,
      held,
      paused,
      queued: taken === "queued",
    });
    return InterventionState.make({ held, paused, queued: taken === "queued" });
  }, mutex.withPermits(1));

  if (Option.isSome(options.idle) && options.idleAnsweredOperator) {
    operatorInput = Option.some(restoredAt);
    yield* Effect.logInfo("The restored idle report replies to the operator", {
      sessionId: session.id,
    });
  }
  if (Option.isSome(options.idle)) yield* finish(options.idle.value);
  else if (paused) yield* finish("Session paused before restart");

  return {
    finish: (message: string) => mutex.withPermits(1)(finish(message)),
    /**
     * Runs `announce` and then finishes with `message`, an answer whose wait limit passed, if the
     * session is neither held nor paused. Otherwise keeps `message`, without reporting the session
     * idle, for a later Release, and returns `false`.
     */
    finishOverdue: (message: string, announce: Effect.Effect<void>) =>
      mutex.withPermits(1)(
        Effect.suspend(() => {
          if (!held && !paused)
            return announce.pipe(Effect.andThen(finish(message)), Effect.as(true));
          overdue = Option.some(message);
          return Effect.succeed(false);
        }),
      ),
    /** Drops the answer that `finishOverdue` kept, if any, and returns whether one was kept. */
    dropOverdue: Effect.suspend(() =>
      Option.isNone(overdue)
        ? Effect.succeed(false)
        : mutex.withPermits(1)(
            Effect.sync(() => {
              const kept = Option.isSome(overdue);
              overdue = Option.none();
              return kept;
            }),
          ),
    ),
    intervene,
    recover: Effect.fn("SessionConversation.recover")(function* (
      policy: ContinuationPolicy,
      tools: ReadonlyArray<InterruptedTool>,
      send: (message: string, id?: OperatorMessageId) => Effect.Effect<void, AgentSessionError>,
      empty = false,
    ) {
      yield* Effect.annotateCurrentSpan({ sessionId: session.id });
      if (yield* channel.isTerminal)
        return yield* Effect.logDebug("Skipping continuation of a terminal child", {
          sessionId: session.id,
        });
      if ((held || paused) && Option.isNone(idle))
        yield* finish("Session interrupted before its turn returned");
      for (const { id } of queued) unsent.add(id);
      yield* policy.recover(
        { held, paused, idle: Option.isSome(idle), empty },
        tools,
        queued,
        channel.emit,
        (message, id) =>
          send(message, id).pipe(
            Effect.andThen(
              id === undefined
                ? Effect.suspend(() => {
                    if (Option.isNone(operatorInput)) return Effect.void;
                    operatorInput = Option.none();
                    return Effect.logInfo(
                      "The harness sent its own continuation input; the next answer no longer replies to the operator",
                      { sessionId: session.id },
                    );
                  })
                : sent(id),
            ),
          ),
      );
    }, mutex.withPermits(1)),
    /** Acknowledges only the messages identified by the native harness, read at `at`. */
    read: (ids: ReadonlyArray<OperatorMessageId>, at: ReadPoint = "now") =>
      mutex.withPermits(1)(deliver(ids, at)),
    /** Waits until the session is not paused; harness hooks run it before each tool call or model request. */
    awaitUnpaused: Effect.suspend(() => (paused ? Deferred.await(resume) : Effect.void)),
    isPaused: Effect.sync(() => paused),
    /** Whether the session finished a turn and waits under operator supervision. */
    isIdle: Effect.sync(() => Option.isSome(idle)),
    isClosing: Effect.sync(() => closing),
    /** The queued operator messages that the harness hasn't read, oldest first. */
    unread: Effect.sync(() => queued.map(({ id, message }) => ({ id, message }))),
  };
});
