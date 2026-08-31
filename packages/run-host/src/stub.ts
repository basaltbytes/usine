import { AgentRuntime, SessionResult, type RunningSession } from "@usine/agents";
import { Agent } from "@usine/core";
import { Cause, Deferred, Effect, Layer, Option, Queue, Stream } from "effect";

/** Explicit deterministic adapter used only by process-level executor tests. */
export const stubLayer = (delayMillis = 0) =>
  Layer.effect(
    AgentRuntime,
    Effect.succeed(
      AgentRuntime.of({
        launch: (request) =>
          Effect.gen(function* () {
            const model = Option.getOrElse(request.spec.parentModel, () =>
              Agent.ModelId.make("stub/parent"),
            );
            const session = new Agent.ParentSession({
              id: Agent.SessionId.make(`parent:${request.spec.attemptId}`),
              agent: request.spec.agent.name,
              brain: new Agent.BrainSpec({
                harness: "pi",
                model,
                effort: request.spec.agent.brain.effort,
              }),
            });
            const events = yield* Queue.make<Agent.SessionEvent, Cause.Done>();
            const result = yield* Deferred.make<SessionResult>();
            yield* Queue.offer(events, new Agent.SessionStarted({ session }));
            yield* Queue.offer(
              events,
              new Agent.TextOutput({ session, text: `Working on ${request.spec.task}` }),
            );
            yield* Effect.gen(function* () {
              if (delayMillis > 0) yield* Effect.sleep(`${delayMillis} millis`);
              yield* Queue.offer(events, new Agent.SessionFinished({ session }));
              yield* Deferred.succeed(
                result,
                new SessionResult({ message: `Completed: ${request.spec.task}` }),
              );
              yield* Queue.end(events);
            }).pipe(Effect.forkScoped);
            const steer = (message: string) =>
              Queue.offer(
                events,
                new Agent.TextOutput({ session, text: `Steer received: ${message}` }),
              ).pipe(Effect.asVoid);
            return {
              events: Stream.fromQueue(events),
              interrupt: Effect.void,
              result: Deferred.await(result),
              steer,
            } satisfies RunningSession;
          }),
      }),
    ),
  );
