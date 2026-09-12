import { AgentSession, SessionIdle, SessionResumed } from "@usine/core/agent/session";
import { InterventionState, type OperatorAction } from "@usine/core/attempt/channel";
import { Deferred, Effect, Option, Semaphore } from "effect";
import { type AgentSessionError, SessionOperationError } from "../runtime.ts";
import type { SessionChannel } from "./session.ts";

interface ConversationOptions {
  readonly session: AgentSession;
  readonly channel: SessionChannel;
  /** Queues guidance during a turn, or starts another turn in the same idle session. */
  readonly send: (
    message: string,
    activity: "running" | "idle",
  ) => Effect.Effect<void, AgentSessionError>;
  /** Requests a pause using the harness's boundary mechanism. */
  readonly pause: Effect.Effect<void, AgentSessionError>;
  /** Releases harness resources only once the session can actually return. */
  readonly beforeFinish: Effect.Effect<void, AgentSessionError>;
}

/** Keeps an idle child addressable while held, and parks interrupted sessions until guidance arrives. */
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

  const finish = Effect.fn("SessionConversation.finish")(function* (message: string) {
    yield* Effect.annotateCurrentSpan({ sessionId: session.id });
    if (yield* channel.isTerminal) return;
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

  const intervene = Effect.fn("SessionConversation.intervene")(function* (action: OperatorAction) {
    yield* Effect.annotateCurrentSpan({ sessionId: session.id, action: action._tag });
    if (yield* channel.isTerminal) {
      return yield* new SessionOperationError({
        operation: "steer",
        sessionId: Option.some(session.id),
        message: "This session has already returned",
        cause: new Error("session closed"),
      });
    }
    if (action._tag === "Release") {
      if (session._tag === "ParentSession") {
        return yield* new SessionOperationError({
          operation: "steer",
          sessionId: Option.some(session.id),
          message: "Only a child session can be released",
          cause: new Error("parent has no Hold"),
        });
      }
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
      const activity = Option.isSome(idle) ? "idle" : "running";
      // Completion shares this lock: a successful message owns its Hold before
      // an in-flight turn can return, while a refused message changes no state.
      yield* options.send(action.message, activity);
      if (action._tag === "OperatorMessage" && session._tag === "ChildSession") held = true;
      paused = false;
      idle = Option.none();
      yield* Deferred.succeed(resume, undefined);
      resume = yield* Deferred.make<void>();
      yield* channel.emit(new SessionResumed({ session }));
    }
    yield* Effect.logInfo("Session intervention applied", {
      sessionId: session.id,
      action: action._tag,
      held,
      paused,
    });
    return new InterventionState({ held, paused });
  }, mutex.withPermits(1));

  return {
    finish: (message: string) => mutex.withPermits(1)(finish(message)),
    intervene,
    /** Harness hooks await this before starting another tool or model request. */
    awaitUnpaused: Effect.suspend(() => (paused ? Deferred.await(resume) : Effect.void)),
    isPaused: Effect.sync(() => paused),
    isClosing: Effect.sync(() => closing),
  };
});
