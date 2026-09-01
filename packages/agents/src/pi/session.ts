import { Agent } from "@usine/core";
import { Cause, Deferred, Effect, Queue, Ref } from "effect";
import { type AgentSessionError, SessionResult } from "../runtime.ts";

export interface SessionChannelOptions {
  /** Human-readable adapter name used in the terminal log lines. */
  readonly label: string;
  readonly sessionId: Agent.SessionId;
}

/**
 * Terminal-once state every session adapter shares: one event queue, one
 * result, and a latch guaranteeing exactly one terminal transition. Cleanups
 * registered through `onTerminal` run on whichever transition wins.
 */
export interface SessionChannel {
  readonly events: Queue.Queue<Agent.SessionEvent, AgentSessionError | Cause.Done>;
  readonly result: Deferred.Deferred<SessionResult, AgentSessionError>;
  readonly isTerminal: Effect.Effect<boolean>;
  readonly onTerminal: (cleanup: () => void) => void;
  /** Offers one event, logging instead of silently dropping it after the terminal transition. */
  readonly emit: (event: Agent.SessionEvent) => Effect.Effect<void>;
  readonly fail: (error: AgentSessionError) => Effect.Effect<void>;
  readonly finish: (session: Agent.Session, message: string) => Effect.Effect<void>;
}

export const sessionChannel = Effect.fn("SessionChannel.make")(function* (
  options: SessionChannelOptions,
) {
  const events = yield* Queue.make<Agent.SessionEvent, AgentSessionError | Cause.Done>();
  const result = yield* Deferred.make<SessionResult, AgentSessionError>();
  const terminal = yield* Ref.make(false);
  const cleanups: Array<() => void> = [];
  const runCleanups = Effect.sync(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  const emit = (event: Agent.SessionEvent) =>
    Queue.offer(events, event).pipe(
      Effect.flatMap((accepted) =>
        accepted
          ? Effect.void
          : Effect.logWarning(`${options.label} dropped an event after the terminal transition`, {
              event: event._tag,
              sessionId: options.sessionId,
            }),
      ),
    );

  const fail = Effect.fn("SessionChannel.fail")(function* (error: AgentSessionError) {
    if (yield* Ref.getAndSet(terminal, true)) return;
    yield* Effect.logError(`${options.label} failed`, {
      errorTag: error._tag,
      message: error.message,
      sessionId: options.sessionId,
    });
    yield* Deferred.fail(result, error);
    yield* Queue.fail(events, error);
    yield* runCleanups;
  });

  const finish = Effect.fn("SessionChannel.finish")(function* (
    session: Agent.Session,
    message: string,
  ) {
    if (yield* Ref.getAndSet(terminal, true)) return;
    yield* Queue.offer(events, new Agent.SessionFinished({ session }));
    yield* Deferred.succeed(result, new SessionResult({ message }));
    yield* Queue.end(events);
    yield* runCleanups;
    yield* Effect.logInfo(`${options.label} finished`, { sessionId: options.sessionId });
  });

  return {
    events,
    result,
    isTerminal: Ref.get(terminal),
    onTerminal: (cleanup: () => void) => {
      cleanups.push(cleanup);
    },
    emit,
    fail,
    finish,
  } satisfies SessionChannel;
});
