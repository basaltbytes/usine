import {
  AgentRuntime,
  type AgentSessionError,
  LaunchRequest,
  type RunningSession,
  SessionResult,
} from "@usine/agents/runtime";
import { Agent, AgentName, AgentPersona } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionEvent,
  AgentSessionId,
  ChildSession,
  ChildSessionBudget,
  ParentSession,
} from "@usine/core/agent/session";
import { AttemptId, AttemptTask } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { CommitSha, RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { Cause, DateTime, Deferred, Effect, Option, Queue, Stream } from "effect";

export const spec = new AttemptChannel.RunSpec({
  attemptId: AttemptId.make("run/execute/1"),
  repository: RepositoryName.make("acme/demo"),
  revision: RepositoryRevision.make("main"),
  baseCommit: CommitSha.make("a".repeat(40)),
  payload: { title: "Fix café rendering" },
  task: AttemptTask.make("Fix café rendering."),
  agent: new Agent({
    name: AgentName.make("developer"),
    brain: new BrainSpec({ harness: "codex", model: ModelId.make("test/child"), effort: "high" }),
    parentModel: Option.none(),
    parentEffort: Option.none(),
    persona: AgentPersona.make("Implement the task."),
  }),
  parentModel: Option.none(),
  maxChildren: ChildSessionBudget.make(4),
  parentEffort: "medium",
  resume: Option.none(),
});

export const start = (runSpec = spec) =>
  new AttemptChannel.Start({ version: AttemptChannel.PROTOCOL_VERSION, spec: runSpec });

export const command = (
  payload: AttemptChannel.InboundPayload,
  sequence = 1,
  attemptId = spec.attemptId,
  target: AttemptChannel.SessionTarget = new AttemptChannel.ParentTarget(),
) =>
  new AttemptChannel.InboundEnvelope({
    operator: "operator",
    version: AttemptChannel.PROTOCOL_VERSION,
    attemptId,
    sequence: AttemptChannel.Sequence.make(sequence),
    sentAt: DateTime.makeUnsafe("2026-09-06T12:00:00Z"),
    target,
    payload,
  });

/** The test decides when activity ends and when the SDK returns, without timers or credentials. */
export const controlledSession = Effect.fn("test.controlledSession")(function* (
  interrupt: RunningSession["interrupt"] = Effect.void,
) {
  const events = yield* Queue.make<AgentSessionEvent, AgentSessionError | Cause.Done>();
  const result = yield* Deferred.make<SessionResult, AgentSessionError>();
  const launches = yield* Queue.make<LaunchRequest>();
  const steers = yield* Queue.make<string>();
  const released = yield* Deferred.make<void>();
  // A fake child registered on launch so takeover routing to a child id is testable.
  const childSteers = yield* Queue.make<string>();
  const childInterrupted = yield* Deferred.make<void>();
  const session = new ParentSession({
    id: AgentSessionId.make("parent:run/execute/1"),
    agent: spec.agent.name,
    brain: new BrainSpec({
      harness: "pi",
      model: ModelId.make("sdk/selected-parent"),
      effort: "medium",
    }),
  });
  const child = new ChildSession({
    id: AgentSessionId.make("parent:run/execute/1:child:1"),
    parentId: session.id,
    agent: spec.agent.name,
    brain: spec.agent.brain,
  });
  const childSession: RunningSession = {
    session: child,
    events: Stream.empty,
    result: Effect.never,
    steer: (message) => Queue.offer(childSteers, message).pipe(Effect.asVoid),
    interrupt: Deferred.succeed(childInterrupted, undefined).pipe(Effect.asVoid),
    intervene: (action) =>
      Effect.gen(function* () {
        if (action._tag === "OperatorMessage" || action._tag === "Steer")
          yield* Queue.offer(childSteers, action.message);
        if (action._tag === "Interrupt") yield* Deferred.succeed(childInterrupted, undefined);
        return new AttemptChannel.InterventionState({
          held: action._tag !== "Release",
          paused: action._tag === "Interrupt",
        });
      }),
  };
  const runtime = AgentRuntime.of({
    launch: Effect.fn("test.AgentRuntime.launch")(function* (request, children) {
      yield* Queue.offer(launches, request);
      yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
      yield* children.register(childSession);
      return {
        session,
        events: Stream.fromQueue(events),
        result: Deferred.await(result),
        steer: (message) => Queue.offer(steers, message).pipe(Effect.asVoid),
        interrupt,
        intervene: (action) =>
          Effect.gen(function* () {
            if (action._tag === "OperatorMessage" || action._tag === "Steer")
              yield* Queue.offer(steers, action.message);
            return new AttemptChannel.InterventionState({
              held: false,
              paused: action._tag === "Interrupt",
            });
          }),
      } satisfies RunningSession;
    }),
  });
  return {
    runtime,
    session,
    child,
    events,
    result,
    launches,
    steers,
    childSteers,
    childInterrupted,
    released,
  };
});
