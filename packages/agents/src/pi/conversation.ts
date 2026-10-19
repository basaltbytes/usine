import { ChildSession, SessionIdle, SessionResumed } from "@usine/core/agent/session";
import { InterventionState, type OperatorAction } from "@usine/core/attempt/channel";
import { Deferred, Effect, Option, Semaphore } from "effect";
import { type AgentSessionError, type OnDelivery, SessionOperationError } from "../runtime.ts";
import type { SessionChannel } from "./session.ts";

/**
 * How a harness took an operator message: `read` when it starts the next turn
 * of an idle session or joins the running turn at once, `queued` when the
 * harness reads it only at its next boundary.
 */
export type MessageTaken = "read" | "queued";

interface ConversationOptions {
  readonly session: ChildSession;
  readonly channel: SessionChannel;
  /**
   * Queues guidance during a turn, or starts another turn in the same idle
   * session. A harness that answers `queued` reports the read later through
   * the conversation's `read`.
   */
  readonly send: (
    message: string,
    activity: "running" | "idle",
  ) => Effect.Effect<MessageTaken, AgentSessionError>;
  /** Requests a pause using the harness's boundary mechanism. */
  readonly pause: Effect.Effect<void, AgentSessionError>;
  /** Releases harness resources only once the session can actually return. */
  readonly beforeFinish: Effect.Effect<void, AgentSessionError>;
}

/** An operator message the harness queued, and whom to tell once it reads it or the session stops first. */
interface QueuedMessage {
  readonly message: string;
  readonly onDelivery: OnDelivery;
}

/**
 * Keeps an idle child addressable while held, and parks interrupted sessions
 * until guidance arrives. Operator messages the harness queued are reported
 * read when the harness says so, when its turn ends, or as unread when the
 * conversation's scope closes first.
 */
export const sessionConversation = Effect.fn("SessionConversation.make")(function* (
  options: ConversationOptions,
) {
  const { session, channel } = options;
  const mutex = yield* Semaphore.make(1);
  let held = false;
  let paused = false;
  let idle = Option.none<string>();
  let closing = false;
  let resume = yield* Deferred.make<void>();
  const queued: Array<QueuedMessage> = [];

  /** Reports the oldest `count` queued messages read, with the session's state now. */
  const deliver = (count: number) =>
    Effect.suspend(() => {
      const read = queued.splice(0, Math.max(0, count));
      if (read.length === 0) return Effect.void;
      const state = new InterventionState({ held, paused });
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
    // A turn ends only after its harness read every message queued into it; an interrupted turn may have dropped them.
    if (!paused) yield* deliver(queued.length);
    if (held || paused) {
      idle = Option.some(message);
      yield* channel.emit(new SessionIdle({ session }));
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
      return yield* new SessionOperationError({
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
      const activity = Option.isSome(idle) ? "idle" : "running";
      // Completion shares this lock: a successful message owns its Hold before
      // an in-flight turn can return, while a refused message changes no state.
      taken = yield* options.send(action.message, activity);
      if (action._tag === "OperatorMessage") held = true;
      paused = false;
      idle = Option.none();
      yield* Deferred.succeed(resume, undefined);
      resume = yield* Deferred.make<void>();
      if (taken === "queued") queued.push({ message: action.message, onDelivery });
      if (stopped) yield* channel.emit(new SessionResumed({ session }));
    }
    yield* Effect.logInfo("Session intervention applied", {
      sessionId: session.id,
      action: action._tag,
      held,
      paused,
      queued: taken === "queued",
    });
    return new InterventionState({ held, paused, queued: taken === "queued" });
  }, mutex.withPermits(1));

  return {
    finish: (message: string) => mutex.withPermits(1)(finish(message)),
    intervene,
    /**
     * Reports queued operator messages read: `count` answers how many of the
     * oldest the harness has read, given the queued messages oldest first.
     */
    read: (count: (messages: ReadonlyArray<string>) => number) =>
      mutex.withPermits(1)(
        Effect.suspend(() => deliver(count(queued.map(({ message }) => message)))),
      ),
    /** Harness hooks await this before starting another tool or model request. */
    awaitUnpaused: Effect.suspend(() => (paused ? Deferred.await(resume) : Effect.void)),
    isPaused: Effect.sync(() => paused),
    isClosing: Effect.sync(() => closing),
  };
});
