import { AgentRuntime, type RunningSession, SessionResult } from "@usine/agents/runtime";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionEvent,
  AgentSessionId,
  ParentSession,
  SessionFinished,
  SessionStarted,
  TextOutput,
} from "@usine/core/agent/session";
import { InterventionState } from "@usine/core/attempt/channel";
import { Cause, Deferred, Effect, Layer, Option, Queue, Stream } from "effect";

/** A deterministic agent runtime for process-level executor tests. */
export const stubLayer = (delayMillis = 0) =>
  Layer.effect(
    AgentRuntime,
    Effect.succeed(
      AgentRuntime.of({
        launch: (request) =>
          Effect.gen(function* () {
            const model = Option.getOrElse(request.spec.parentModel, () =>
              ModelId.make("stub/parent"),
            );
            const session = new ParentSession({
              id: AgentSessionId.make(`parent:${request.spec.attemptId}`),
              agent: request.spec.agent.name,
              brain: new BrainSpec({
                harness: "pi",
                model,
                effort: request.spec.parentEffort,
              }),
            });
            const events = yield* Queue.make<AgentSessionEvent, Cause.Done>();
            const result = yield* Deferred.make<SessionResult>();
            let paused = false;
            let resume = yield* Deferred.make<void>();
            yield* Queue.offer(events, new SessionStarted({ session }));
            yield* Queue.offer(
              events,
              new TextOutput({ session, text: `Working on ${request.spec.task}` }),
            );
            yield* Effect.gen(function* () {
              if (delayMillis > 0) yield* Effect.sleep(`${delayMillis} millis`);
              if (paused) yield* Deferred.await(resume);
              yield* Queue.offer(events, new SessionFinished({ session }));
              yield* Deferred.succeed(
                result,
                new SessionResult({ message: `Completed: ${request.spec.task}` }),
              );
              yield* Queue.end(events);
            }).pipe(Effect.forkScoped);
            const steer = (message: string) =>
              Queue.offer(
                events,
                new TextOutput({ session, text: `Steer received: ${message}` }),
              ).pipe(Effect.asVoid);
            return {
              session,
              events: Stream.fromQueue(events),
              interrupt: Effect.void,
              result: Deferred.await(result),
              steer,
              intervene: (action) =>
                Effect.gen(function* () {
                  if (action._tag === "Interrupt") paused = true;
                  if (action._tag === "OperatorMessage" || action._tag === "Steer") {
                    yield* steer(action.message);
                    paused = false;
                    yield* Deferred.succeed(resume, undefined);
                    resume = yield* Deferred.make<void>();
                  }
                  return new InterventionState({ held: false, paused });
                }),
            } satisfies RunningSession;
          }),
      }),
    ),
  );
