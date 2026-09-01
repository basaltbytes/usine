import { assert, describe, it } from "@effect/vitest";
import {
  AgentFile,
  AgentName,
  IssueTrigger,
  LoadedInstance,
  LoopFile,
  LoopName,
  ModelId,
  Persona,
  PromptTemplate,
  UsineConfig,
} from "@usine/config";
import {
  Agent,
  Attempt,
  AttemptChannel,
  Event,
  Repository,
  Run,
  RunState,
  Step,
  Worker,
} from "@usine/core";
import {
  LoopControl,
  LoopRuntimeState,
  ProjectionRevision,
  RunEngine,
  RunReader,
  RunSnapshot,
  TranscriptEntry,
  TranscriptSequence,
} from "@usine/engine";
import { Source } from "@usine/expression";
import { DateTime, Effect, Layer, Option, Ref, Schema } from "effect";
import {
  Operator,
  PollCycle,
  PollingTriggers,
  RepositoryPollFailure,
  ScheduleCycle,
  ScheduleTriggers,
  TranscriptCursor,
} from "../src/index.ts";

const now = DateTime.makeUnsafe("2026-08-31T12:00:00.000Z");
const runId = Run.RunId.make("run-operator-test");
const attemptId = Attempt.AttemptId.make("attempt-operator-test");
const loopName = LoopName.make("review-issue");
const repository = Repository.Name.make("basaltbytes/usine");
const brain = new Agent.BrainSpec({
  harness: "codex",
  model: ModelId.make("gpt-5.6-sol"),
  effort: "high",
});

const config = Schema.decodeUnknownSync(UsineConfig)({
  version: 1,
  repos: [{ name: repository }],
});
const agentFile = new AgentFile({
  name: AgentName.make("developer"),
  harness: brain.harness,
  model: brain.model,
  effort: brain.effort,
  parentModel: Option.none(),
  persona: Persona.make("Review the issue."),
});
const loop = new LoopFile({
  name: loopName,
  trigger: new IssueTrigger({ on: "issue", if: Source.make("true") }),
  selector: Option.none(),
  approval: "required",
  step: Step.StepName.make("run"),
  agent: agentFile.name,
  body: PromptTemplate.make("Review it."),
});
const instance = new LoadedInstance({
  config,
  agents: [agentFile],
  invalidAgents: [],
  loops: [loop],
  quarantinedLoops: [],
});

const snapshot = new RunSnapshot({
  event: new Event.Event({
    id: Event.EventId.make("event-operator-test"),
    dedupKey: Event.DedupKey.make("event-operator-test"),
    payload: { number: 31 },
    receivedAt: now,
  }),
  run: new Run.Run({
    id: runId,
    eventId: Event.EventId.make("event-operator-test"),
    loop: loopName,
    state: new RunState.Waiting(),
    openedAt: now,
  }),
  step: new Step.Step({ runId, name: Step.StepName.make("run"), result: Option.none() }),
  attempts: [
    new Attempt.Attempt({
      id: attemptId,
      runId,
      stepName: Step.StepName.make("run"),
      worker: Worker.Name.make("local"),
      number: Attempt.AttemptNumber.make(1),
      brain,
      parentModel: Option.none(),
      startedAt: now,
      outcome: Option.none(),
    }),
  ],
  repository,
  revision: Repository.Revision.make("main"),
  task: AttemptChannel.Task.make("Review issue 31."),
  agent: new Agent.Agent({
    name: agentFile.name,
    brain,
    parentModel: Option.none(),
    persona: agentFile.persona,
  }),
  parentModel: Option.none(),
});

const parent = new Agent.ParentSession({
  id: Agent.SessionId.make("parent-session"),
  agent: agentFile.name,
  brain,
});
const child = new Agent.ChildSession({
  id: Agent.SessionId.make("child-session"),
  parentId: parent.id,
  agent: AgentName.make("researcher"),
  brain,
});
const transcript = [
  new TranscriptEntry({
    sequence: TranscriptSequence.make(1),
    attemptId,
    direction: "outbound",
    envelope: new AttemptChannel.OutboundEnvelope({
      version: 3,
      attemptId,
      sequence: AttemptChannel.Sequence.make(1),
      sentAt: now,
      payload: new AttemptChannel.SessionEvent({
        event: new Agent.TextOutput({ session: parent, text: "Parent update" }),
      }),
    }),
    receivedAt: now,
  }),
  new TranscriptEntry({
    sequence: TranscriptSequence.make(2),
    attemptId,
    direction: "outbound",
    envelope: new AttemptChannel.OutboundEnvelope({
      version: 3,
      attemptId,
      sequence: AttemptChannel.Sequence.make(2),
      sentAt: now,
      payload: new AttemptChannel.SessionEvent({
        event: new Agent.ToolStarted({
          session: child,
          callId: "call-1",
          tool: "search",
          input: { issue: 31 },
        }),
      }),
    }),
    receivedAt: now,
  }),
];

interface RecordedApproval {
  readonly runId: Run.RunId;
  readonly event: Event.Event;
}

const testLayer = (
  approved: Ref.Ref<ReadonlyArray<RecordedApproval>>,
  overviewReads: Ref.Ref<number>,
  projectionRevision: Ref.Ref<Option.Option<ProjectionRevision>>,
) => {
  const readTranscript = ({ after }: { readonly after: Option.Option<TranscriptSequence> }) =>
    Effect.succeed(
      Option.match(after, {
        onNone: () => transcript,
        onSome: (cursor) => transcript.filter((entry) => entry.sequence > cursor),
      }),
    );
  const runs = Layer.succeed(RunEngine)({
    approve: (id, event) => Ref.update(approved, (entries) => [...entries, { runId: id, event }]),
    cancel: () => Effect.void,
    inspect: () => Effect.succeed(snapshot),
    reconcile: () => Effect.void,
    retry: () => Effect.void,
    revoke: () => Effect.succeed([]),
    submit: () => Effect.die("unused"),
    transcript: readTranscript,
  });
  const reader = Layer.succeed(RunReader)({
    inspect: () => Effect.succeed(snapshot),
    list: () => Ref.updateAndGet(overviewReads, (reads) => reads + 1).pipe(Effect.as([snapshot])),
    revision: () => Ref.get(projectionRevision),
    transcript: readTranscript,
  });
  const controls = Layer.succeed(LoopControl)({
    isPaused: () => Effect.succeed(true),
    pause: () => Effect.succeed(new LoopRuntimeState({ loop: loopName, paused: true })),
    states: Effect.succeed([new LoopRuntimeState({ loop: loopName, paused: true })]),
    unpause: () => Effect.succeed(new LoopRuntimeState({ loop: loopName, paused: false })),
  });
  const polling = Layer.succeed(PollingTriggers)({
    poll: () => Effect.die("unused"),
    run: () => Effect.never,
    latest: Effect.succeed(
      Option.some(
        new PollCycle({
          repositories: 1,
          changedItems: 0,
          submissions: [],
          revokedRuns: 0,
          failures: [
            new RepositoryPollFailure({
              repository,
              errorTag: "GitHubApiError",
              message: "GitHub was unavailable",
            }),
          ],
          nextPollAt: Option.none(),
        }),
      ),
    ),
  });
  const schedules = Layer.succeed(ScheduleTriggers)({
    tick: () => Effect.die("unused"),
    run: () => Effect.never,
    latest: Effect.succeed(
      Option.some(
        new ScheduleCycle({
          loops: 0,
          fanout: 0,
          submissions: [],
          skipped: 0,
          alreadyFired: 0,
          failures: [],
          nextTickAt: Option.none(),
        }),
      ),
    ),
  });
  const dependencies = Layer.mergeAll(runs, reader, controls, polling, schedules);
  return Operator.layer.pipe(Layer.provide(dependencies));
};

describe("Operator", () => {
  it.effect("projects needs-you state and protocol child activity without recursive nesting", () =>
    Effect.gen(function* () {
      const approved = yield* Ref.make<ReadonlyArray<RecordedApproval>>([]);
      const overviewReads = yield* Ref.make(0);
      const projectionRevision = yield* Ref.make(Option.some(ProjectionRevision.make(1)));
      yield* Effect.gen(function* () {
        const operator = yield* Operator;
        const overview = yield* operator.overview(instance);
        yield* operator.overview(instance);
        assert.strictEqual(yield* Ref.get(overviewReads), 1);
        yield* Ref.set(projectionRevision, Option.some(ProjectionRevision.make(2)));
        yield* operator.overview(instance);
        assert.strictEqual(yield* Ref.get(overviewReads), 2);
        // A missing invalidation singleton must bypass the cache entirely.
        yield* Ref.set(projectionRevision, Option.none());
        yield* operator.overview(instance);
        yield* operator.overview(instance);
        assert.strictEqual(yield* Ref.get(overviewReads), 4);
        assert.strictEqual(overview.projects[0]?.status, "needs-you");
        assert.strictEqual(overview.loops[0]?.paused, true);
        assert.strictEqual(overview.projects[0]?.runs[0]?.loopPaused, true);
        assert.deepStrictEqual(
          overview.needsYou.map(({ kind }) => kind),
          ["approval", "poll-failure"],
        );

        const detail = yield* operator.detail(runId);
        assert.strictEqual(detail.eventDedupKey, snapshot.event.dedupKey);
        assert.deepStrictEqual(detail.eventPayload, { number: 31 });
        assert.strictEqual(detail.run.attempts[0]?.number, 1);
        assert.strictEqual(detail.transcript[0]?.scope, "parent");
        assert.strictEqual(detail.transcript[0]?.detail, "Parent update");
        assert.strictEqual(detail.transcript[1]?.scope, "child");
        assert.strictEqual(detail.transcript[1]?.parentId, parent.id);
        assert.strictEqual(detail.transcript[1]?.sessionId, child.id);

        const tail = yield* operator.detail(runId, Option.some(TranscriptCursor.make(1)));
        assert.deepStrictEqual(
          tail.transcript.map(({ sequence }) => sequence),
          [2],
        );

        yield* operator.approve(runId);
        const approvals = yield* Ref.get(approved);
        const recorded = approvals[0];
        assert(recorded !== undefined);
        assert.strictEqual(recorded.runId, runId);
        // The approval Event the waiting run consumes must be recorded whole:
        // deterministic identity for idempotent re-approval, typed payload.
        assert.strictEqual<string>(recorded.event.id, recorded.event.dedupKey);
        assert.strictEqual<string>(
          recorded.event.dedupKey,
          JSON.stringify(["operator-approval", runId]),
        );
        assert.deepStrictEqual(recorded.event.payload, {
          runId,
          decision: "approved",
        });
      }).pipe(Effect.provide(testLayer(approved, overviewReads, projectionRevision)));
    }),
  );
});
