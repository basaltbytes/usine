import { ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  ParentSession,
  SessionFinished,
  SessionStarted,
  TextOutput,
} from "@usine/core/agent/session";
import type { AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AgentFailure, type AttemptFailure, InfraFailure } from "@usine/core/attempt/failure";
import { AttemptReport, type AttemptRequest, AttemptRuntime } from "@usine/durable/attempt-runtime";
import { StepResult } from "@usine/core/step/result";
import { DateTime, Deferred, Effect, Layer, Option } from "effect";

/** What a scripted parent can do while `execute` runs it. */
interface StubParentContext {
  readonly request: AttemptRequest;
  /** Records one outbound envelope with the task's next sequence. */
  readonly emit: (payload: AttemptChannel.OutboundPayload) => Effect.Effect<void, AttemptFailure>;
  /** The parent session the stub reports events for. */
  readonly session: ParentSession;
  /** Whether this `execute` call reattached a task a previous runtime started. */
  readonly reattached: boolean;
}

/** The parent's work after Started; its result is the parent's final message. */
export type StubParent = (context: StubParentContext) => Effect.Effect<string, AttemptFailure>;

interface StoredTask {
  readonly request: AttemptRequest;
  state: "live" | "finished" | "canceled";
  outbound: number;
  inbound: number;
}

/**
 * The durable storage behind stub runtimes: tasks and their sequence counters
 * survive a runtime being closed and built again, as pi-durable storage
 * survives an orchestrator restart.
 */
export class StubStorage {
  readonly tasks = new Map<AttemptId, StoredTask>();
}

/** Completes at once with `Completed: <task>`. */
export const completes: StubParent = ({ request }) =>
  Effect.succeed(`Completed: ${request.spec.task}`);

/** Works for `millis` before completing. */
export const worksFor =
  (millis: number): StubParent =>
  (context) =>
    Effect.sleep(`${millis} millis`).pipe(Effect.andThen(completes(context)));

/**
 * An in-memory `AttemptRuntime` over `storage`. It records Started, the
 * parent's session events, intervention receipts, and a Final without facts
 * (the executor harvests those) through the Attempt's sink, numbering them per
 * task so a reattached `execute` continues the sequence. Only a completed parent leaves the live state: interrupting
 * `execute` (a stopped process) or a failing parent leaves the task live until
 * someone cancels it, so tests see whether the executor stopped it.
 */
export const stubAttemptRuntime = (storage: StubStorage, parent: StubParent = completes) =>
  Layer.effect(
    AttemptRuntime,
    Effect.sync(() => {
      const attached = new Map<
        AttemptId,
        { readonly io: AttemptChannel.Sink; readonly canceled: Deferred.Deferred<void> }
      >();
      const envelope = (task: StoredTask, payload: AttemptChannel.OutboundPayload) =>
        Effect.map(
          DateTime.now,
          (sentAt) =>
            new AttemptChannel.OutboundEnvelope({
              version: AttemptChannel.PROTOCOL_VERSION,
              attemptId: task.request.spec.attemptId,
              sequence: AttemptChannel.Sequence.make(++task.outbound),
              sentAt,
              payload,
            }),
        );

      const execute = (request: AttemptRequest, io: AttemptChannel.Sink) =>
        Effect.gen(function* () {
          const attemptId = request.spec.attemptId;
          const stored = storage.tasks.get(attemptId);
          if (stored !== undefined && stored.state !== "live")
            return yield* new InfraFailure({
              message: `Attempt ${attemptId} has no live task`,
              cause: new Error(stored.state),
            });
          const task: StoredTask = stored ?? { request, state: "live", outbound: 0, inbound: 0 };
          storage.tasks.set(attemptId, task);
          const canceled = yield* Deferred.make<void>();
          attached.set(attemptId, { io, canceled });
          const session = new ParentSession({
            id: AgentSessionId.make(`parent:${attemptId}`),
            agent: request.spec.agent.name,
            brain: request.spec.agent.brain,
          });
          const emit = (payload: AttemptChannel.OutboundPayload) =>
            Effect.flatMap(envelope(task, payload), (sent) => io.append("outbound", sent));
          const event = (event: AttemptChannel.SessionEvent["event"]) =>
            emit(new AttemptChannel.SessionEvent({ event }));
          if (stored === undefined) {
            yield* emit(
              new AttemptChannel.Started({
                parentModel: Option.getOrElse(request.spec.parentModel, () =>
                  ModelId.make("stub/parent"),
                ),
              }),
            );
            yield* event(new SessionStarted({ session }));
            yield* event(new TextOutput({ session, text: `Working on ${request.spec.task}` }));
          } else {
            yield* event(new TextOutput({ session, text: "Resumed after a restart" }));
          }
          const message = yield* parent({
            request,
            emit,
            session,
            reattached: stored !== undefined,
          }).pipe(
            Effect.raceFirst(
              Deferred.await(canceled).pipe(
                Effect.andThen(
                  Effect.fail(new AgentFailure({ message: "The parent task was canceled" })),
                ),
              ),
            ),
          );
          yield* event(new SessionFinished({ session }));
          yield* emit(new AttemptChannel.Final({ result: new StepResult({ message, facts: [] }) }));
          task.state = "finished";
          return new AttemptReport({ message });
        }).pipe(Effect.ensuring(Effect.sync(() => attached.delete(request.spec.attemptId))));

      return AttemptRuntime.of({
        execute,
        isLive: (attemptId) => Effect.sync(() => storage.tasks.get(attemptId)?.state === "live"),
        cancel: (attemptId) =>
          Effect.gen(function* () {
            const task = storage.tasks.get(attemptId);
            if (task === undefined || task.state !== "live") return;
            task.state = "canceled";
            const active = attached.get(attemptId);
            if (active !== undefined) yield* Deferred.succeed(active.canceled, undefined);
          }),
        intervene: (attemptId, intervention) =>
          Effect.gen(function* () {
            const task = storage.tasks.get(attemptId);
            const active = attached.get(attemptId);
            if (task === undefined || active === undefined)
              return yield* new AgentFailure({ message: "This Attempt has no live parent" });
            const inputSequence = AttemptChannel.Sequence.make(++task.inbound);
            yield* active.io.append(
              "inbound",
              new AttemptChannel.InboundEnvelope({
                version: AttemptChannel.PROTOCOL_VERSION,
                attemptId,
                sequence: inputSequence,
                sentAt: yield* DateTime.now,
                target: intervention.target,
                operator: intervention.operator,
                payload: intervention.action,
              }),
            );
            yield* active.io.append(
              "outbound",
              yield* envelope(
                task,
                new AttemptChannel.InterventionApplied({
                  inputSequence,
                  intervention,
                  state: new AttemptChannel.InterventionState({ held: false, paused: false }),
                }),
              ),
            );
          }),
      });
    }),
  );
