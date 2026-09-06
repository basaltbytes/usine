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
});

export const start = (runSpec = spec) =>
  new AttemptChannel.Start({ version: AttemptChannel.PROTOCOL_VERSION, spec: runSpec });

export const command = (
  payload: AttemptChannel.InboundPayload,
  sequence = 1,
  attemptId = spec.attemptId,
) =>
  new AttemptChannel.InboundEnvelope({
    version: AttemptChannel.PROTOCOL_VERSION,
    attemptId,
    sequence: AttemptChannel.Sequence.make(sequence),
    sentAt: DateTime.makeUnsafe("2026-09-06T12:00:00Z"),
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
  const session = new ParentSession({
    id: AgentSessionId.make("parent:run/execute/1"),
    agent: spec.agent.name,
    brain: new BrainSpec({
      harness: "pi",
      model: ModelId.make("sdk/selected-parent"),
      effort: "medium",
    }),
  });
  const runtime = AgentRuntime.of({
    launch: Effect.fn("test.AgentRuntime.launch")(function* (request) {
      yield* Queue.offer(launches, request);
      yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
      return {
        session,
        events: Stream.fromQueue(events),
        result: Deferred.await(result),
        steer: (message) => Queue.offer(steers, message).pipe(Effect.asVoid),
        interrupt,
      } satisfies RunningSession;
    }),
  });
  return { runtime, session, events, result, launches, steers, released };
});
