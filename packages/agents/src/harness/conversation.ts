import { ChildSession, SessionIdle, SessionResumed } from "@usine/core/agent/session";
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

interface ConversationOptions {
  readonly session: ChildSession;
  readonly channel: SessionChannel;
  readonly held: boolean;
  readonly paused: boolean;
  readonly unread?: ReadonlyArray<QueuedOperatorMessage>;
  readonly idle: Option.Option<string>;
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
}

/**
 * Keeps an idle child addressable while on Hold, and keeps an interrupted session waiting until
 * guidance arrives. Queued operator messages are reported as read when the harness acknowledges their IDs,
 * and as unread if the scope closes first.
 */
export const sessionConversation = Effect.fn("SessionConversation.make")(function* (
  options: ConversationOptions,
) {
  const { session, channel } = options;
  const mutex = yield* Semaphore.make(1);
  let held = options.held;
  let paused = options.paused;
  let idle = Option.none<string>();
  let closing = false;
  let resume = yield* Deferred.make<void>();
  const journal = yield* ChildSessionJournal.current;
  const queued: Array<QueuedMessage> = (options.unread ?? []).map((message) => ({
    ...message,
    onDelivery: (state) => journal.delivered(message.id, state),
  }));

  /** Reports the identified messages as read, with the current session state. */
  const deliver = (ids: ReadonlyArray<OperatorMessageId>) =>
    Effect.suspend(() => {
      const read = queued.filter(({ id }) => ids.includes(id));
      for (let index = queued.length - 1; index >= 0; index -= 1) {
        const message = queued[index];
        if (message !== undefined && ids.includes(message.id)) queued.splice(index, 1);
      }
      if (read.length === 0) return Effect.void;
      const state = InterventionState.make({ held, paused });
      return Effect.logInfo("The session read queued operator messages", {
        sessionId: session.id,
        read: read.length,
        stillQueued: queued.length,
      }).pipe(
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
    if (held || paused) {
      idle = Option.some(message);
      yield* channel.emit(SessionIdle.make({ session, message: Option.some(message) }));
      yield* Effect.logInfo("Session is idle under operator supervision", {
        sessionId: session.id,
        held,
        paused,
      });
      return;
    }
    closing = true;
    yield* options.beforeFinish.pipe(Effect.tapError(channel.fail));
    yield* channel.finish(session, message);
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
          const replayed = yield* options.send(message.message, activity, message.id);
          if (replayed === "read") yield* deliver([message.id]);
          activity = "running";
        }
      }
      // Completion takes the same lock, so an accepted message sets the Hold before a running turn
      // can return; a rejected message changes no state.
      taken = yield* options.send(action.message, activity, action.id);
      if (action._tag === "OperatorMessage") held = true;
      paused = false;
      idle = Option.none();
      yield* Deferred.succeed(resume, undefined);
      resume = yield* Deferred.make<void>();
      if (taken === "queued") queued.push({ id: action.id, message: action.message, onDelivery });
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

  if (Option.isSome(options.idle)) yield* finish(options.idle.value);
  else if (paused) yield* finish("Session paused before restart");

  return {
    finish: (message: string) => mutex.withPermits(1)(finish(message)),
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
      yield* policy.recover(
        { held, paused, idle: Option.isSome(idle), empty },
        tools,
        queued,
        channel.emit,
        send,
      );
    }, mutex.withPermits(1)),
    /** Acknowledges only the messages identified by the native harness. */
    read: (ids: ReadonlyArray<OperatorMessageId>) => mutex.withPermits(1)(deliver(ids)),
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
