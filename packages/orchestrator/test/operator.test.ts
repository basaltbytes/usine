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
  AttemptFailure,
  Event,
  Item,
  Repository,
  Run,
  RunState,
  Step,
  Worker,
} from "@usine/core";
import {
  LoopControl,
  LoopRuntimeState,
  ItemContentHash,
  ItemNumber,
  ItemProjection,
  ItemProjectionReader,
  ItemProjectionSource,
  ProjectionRevision,
  RepositoryLabelProjectionReader,
  RunEngine,
  RunReader,
  RunSnapshot,
  TranscriptEntry,
  type TranscriptQuery,
  TranscriptSequence,
} from "@usine/engine";
import { GitHubItemWriter, type ItemLabelMutation } from "@usine/github";
import { Source } from "@usine/expression";
import { DateTime, Effect, Layer, Match, Option, Ref, Schema } from "effect";
import {
  ColdTranscriptRequest,
  BoardLaneId,
  BoardMove,
  EarlierTranscriptRequest,
  FailureView,
  Operator,
  PollCycle,
  PollingTriggers,
  RepositoryPollFailure,
  ScheduleCycle,
  ScheduleTriggers,
  TailTranscriptRequest,
  TranscriptCursor,
} from "../src/index.ts";
import { failureView } from "../src/operator/projection.ts";

const now = DateTime.makeUnsafe("2026-08-31T12:00:00.000Z");
const runId = Run.RunId.make("run-operator-test");
const attemptId = Attempt.AttemptId.make("attempt-operator-test");
const loopName = LoopName.make("review-issue");
const repository = Repository.Name.make("basaltbytes/usine");
const itemKey = Item.ItemKey.make("github:basaltbytes/usine:31");
const brain = new Agent.BrainSpec({
  harness: "codex",
  model: ModelId.make("gpt-5.6-sol"),
  effort: "high",
});

const config = Schema.decodeUnknownSync(UsineConfig)({
  version: 1,
  repos: [
    {
      name: repository,
      lanes: [
        { name: "Ready", sources: [{ label: "ready" }] },
        {
          name: "In review",
          sources: [{ label: "ready-for-review" }, { state: "pr-open" }],
        },
      ],
    },
  ],
});
const agentFile = new AgentFile({
  name: AgentName.make("developer"),
  harness: brain.harness,
  model: brain.model,
  effort: brain.effort,
  parentModel: Option.none(),
  parentEffort: Option.none(),
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
  itemKey,
  run: new Run.Run({
    id: runId,
    eventId: Event.EventId.make("event-operator-test"),
    loop: loopName,
    state: new RunState.Waiting(),
    openedAt: now,
  }),
  step: new Step.Step({
    runId,
    name: Step.StepName.make("run"),
    result: Option.none(),
  }),
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
    parentEffort: Option.none(),
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
  ...Array.from({ length: 500 }, (_, index) => {
    const sequence = index + 3;
    return new TranscriptEntry({
      sequence: TranscriptSequence.make(sequence),
      attemptId,
      direction: "outbound",
      envelope: new AttemptChannel.OutboundEnvelope({
        version: 3,
        attemptId,
        sequence: AttemptChannel.Sequence.make(sequence),
        sentAt: now,
        payload: new AttemptChannel.SessionEvent({
          event: new Agent.TextOutput({
            session: parent,
            text: `Parent update ${sequence}`,
          }),
        }),
      }),
      receivedAt: now,
    });
  }),
];

interface RecordedApproval {
  readonly runId: Run.RunId;
  readonly event: Event.Event;
}

const testLayer = (
  approved: Ref.Ref<ReadonlyArray<RecordedApproval>>,
  movedLabels: Ref.Ref<ItemLabelMutation | null>,
  overviewReads: Ref.Ref<number>,
  projectionRevision: Ref.Ref<Option.Option<ProjectionRevision>>,
) => {
  const readTranscript = (query: TranscriptQuery) =>
    Effect.succeed(
      Match.valueTags(query, {
        TranscriptAllQuery: () => transcript,
        TranscriptTailQuery: ({ after, limit }) =>
          transcript.filter((entry) => entry.sequence > after).slice(0, limit),
        TranscriptPageQuery: ({ before, limit }) => {
          const candidates = Option.match(before, {
            onNone: () => transcript,
            onSome: (cursor) => transcript.filter((entry) => entry.sequence < cursor),
          });
          return candidates.slice(-limit);
        },
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
    list: () =>
      Ref.updateAndGet(overviewReads, (reads) => reads + 1).pipe(
        Effect.andThen(Effect.yieldNow),
        Effect.as([snapshot]),
      ),
    revision: () => Ref.get(projectionRevision),
    transcript: readTranscript,
  });
  const controls = Layer.succeed(LoopControl)({
    isPaused: () => Effect.succeed(true),
    pause: () => Effect.succeed(new LoopRuntimeState({ loop: loopName, paused: true })),
    states: Effect.succeed([new LoopRuntimeState({ loop: loopName, paused: true })]),
    unpause: () => Effect.succeed(new LoopRuntimeState({ loop: loopName, paused: false })),
  });
  const itemReader = Layer.succeed(ItemProjectionReader)({
    list: () =>
      Effect.succeed([
        new ItemProjection({
          itemKey,
          repository,
          source: ItemProjectionSource.make("issue"),
          number: ItemNumber.make(31),
          contentHash: ItemContentHash.make("issue-31"),
          payload: {
            number: 31,
            title: "Board lanes",
            body: "Build the Board.",
            url: "https://github.com/basaltbytes/usine/issues/31",
            state: "OPEN",
            stateReason: null,
            createdAt: "2026-08-31T10:00:00Z",
            updatedAt: "2026-08-31T12:00:00Z",
            closedAt: null,
            author: { login: "PhilDL" },
            issueType: null,
            milestone: null,
            labels: {
              totalCount: 2,
              nodes: [{ name: "ready" }, { name: "bug" }],
            },
            assignees: { totalCount: 0, nodes: [] },
            comments: { totalCount: 0, nodes: [] },
            closedByPullRequestsReferences: { totalCount: 0, nodes: [] },
          },
        }),
        new ItemProjection({
          itemKey: Item.ItemKey.make("github:basaltbytes/usine:32"),
          repository,
          source: ItemProjectionSource.make("issue"),
          number: ItemNumber.make(32),
          contentHash: ItemContentHash.make("malformed-issue-32"),
          payload: { number: 32 },
        }),
      ]),
  });
  const repositoryLabelReader = Layer.succeed(RepositoryLabelProjectionReader)({
    get: () => Effect.succeed(Option.none()),
  });
  const github = Layer.succeed(GitHubItemWriter)({
    updateLabels: (_repository, _item, mutation) =>
      Ref.set(movedLabels, mutation).pipe(Effect.as(mutation.add)),
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
  const dependencies = Layer.mergeAll(
    runs,
    reader,
    controls,
    github,
    itemReader,
    repositoryLabelReader,
    polling,
    schedules,
  );
  return Operator.layer.pipe(Layer.provide(dependencies));
};

describe("Operator", () => {
  it.effect("projects needs-you state and protocol child activity without recursive nesting", () =>
    Effect.gen(function* () {
      const approved = yield* Ref.make<ReadonlyArray<RecordedApproval>>([]);
      const movedLabels = yield* Ref.make<ItemLabelMutation | null>(null);
      const overviewReads = yield* Ref.make(0);
      const projectionRevision = yield* Ref.make(Option.some(ProjectionRevision.make(1)));
      yield* Effect.gen(function* () {
        const operator = yield* Operator;
        const [overview] = yield* Effect.all(
          [operator.overview(instance), operator.overview(instance)],
          { concurrency: "unbounded" },
        );
        assert(overview !== undefined);
        assert.strictEqual(yield* Ref.get(overviewReads), 1);
        yield* Ref.set(projectionRevision, Option.some(ProjectionRevision.make(2)));
        yield* operator.overview(instance);
        assert.strictEqual(yield* Ref.get(overviewReads), 2);
        // A missing invalidation singleton must bypass the cache entirely.
        yield* Ref.set(projectionRevision, Option.none());
        yield* operator.overview(instance);
        yield* operator.overview(instance);
        assert.strictEqual(yield* Ref.get(overviewReads), 4);
        // Bypassing the cache also clears its old token: once revision
        // tracking recovers, the first request must rebuild the projection.
        yield* Ref.set(projectionRevision, Option.some(ProjectionRevision.make(2)));
        yield* operator.overview(instance);
        assert.strictEqual(yield* Ref.get(overviewReads), 5);
        assert.strictEqual(overview.projects[0]?.status, "needs-you");
        assert.strictEqual(overview.loops[0]?.paused, true);
        assert.strictEqual(overview.projects[0]?.runs[0]?.loopPaused, true);
        assert.strictEqual(overview.projects[0]?.board.lanes[0]?.name, "Ready");
        assert.strictEqual(overview.projects[0]?.board.lanes[0]?.items[0]?.run?.id, runId);
        assert.strictEqual(overview.projects[0]?.board.lanes[0]?.items[0]?.needsYou, true);
        assert.strictEqual(overview.projects[0]?.board.failures.length, 1);
        assert.strictEqual(
          overview.projects[0]?.board.failures[0]?.itemKey,
          "github:basaltbytes/usine:32",
        );
        assert.deepStrictEqual(
          overview.needsYou.map(({ _tag }) => _tag),
          ["ApprovalNeed", "BoardProjectionNeed", "PollFailureNeed"],
        );

        const detail = yield* operator.detail(runId, new ColdTranscriptRequest());
        assert.strictEqual(detail.eventDedupKey, snapshot.event.dedupKey);
        assert.deepStrictEqual(detail.eventPayload, { number: 31 });
        assert.strictEqual(detail.run.attempts[0]?.number, 1);
        assert.strictEqual(detail.transcript.length, 500);
        assert.strictEqual(detail.transcript[0]?.sequence, 3);
        assert.strictEqual(detail.transcript[0]?.payload._tag, "SessionEvent");
        assert.strictEqual(detail.earlierTranscript[0]?.attemptId, attemptId);
        assert.strictEqual(detail.earlierTranscript[0]?.before, 3);

        const tail = yield* operator.detail(
          runId,
          new TailTranscriptRequest({ after: TranscriptCursor.make(1) }),
        );
        assert.strictEqual(tail.transcript.length, 500);
        assert.strictEqual(tail.transcript[0]?.sequence, 2);
        assert.strictEqual(tail.transcript.at(-1)?.sequence, 501);
        assert.deepStrictEqual(tail.earlierTranscript, []);
        const remainingTail = yield* operator.detail(
          runId,
          new TailTranscriptRequest({ after: TranscriptCursor.make(501) }),
        );
        assert.deepStrictEqual(
          remainingTail.transcript.map(({ sequence }) => sequence),
          [502],
        );

        const earlier = yield* operator.detail(
          runId,
          new EarlierTranscriptRequest({
            attemptId,
            before: TranscriptCursor.make(3),
          }),
        );
        assert.deepStrictEqual(
          earlier.transcript.map(({ sequence }) => sequence),
          [1, 2],
        );
        const childPayload = earlier.transcript[1]?.payload;
        assert(childPayload?._tag === "SessionEvent");
        assert.strictEqual(childPayload.event.session._tag, "ChildSession");
        assert.strictEqual(childPayload.event.session.id, child.id);
        assert.deepStrictEqual(earlier.earlierTranscript, []);
        const wrongAttempt = yield* operator
          .detail(
            runId,
            new EarlierTranscriptRequest({
              attemptId: Attempt.AttemptId.make("another-attempt"),
              before: TranscriptCursor.make(3),
            }),
          )
          .pipe(Effect.flip);
        assert.strictEqual(wrongAttempt._tag, "TranscriptAttemptNotFoundError");

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
        yield* operator.moveBoardItem(
          instance,
          new BoardMove({
            repository,
            item: Item.Number.make(31),
            toLane: BoardLaneId.make("authored:In review"),
          }),
        );
        const mutation = yield* Ref.get(movedLabels);
        assert(mutation !== null);
        assert.deepStrictEqual(mutation.add, ["ready-for-review"]);
        assert.deepStrictEqual(mutation.remove, ["ready"]);
      }).pipe(Effect.provide(testLayer(approved, movedLabels, overviewReads, projectionRevision)));
    }),
  );

  it.effect(
    "rejects Board moves onto unknown projects, Items, Lanes, and state-derived Lanes",
    () =>
      Effect.gen(function* () {
        const approved = yield* Ref.make<ReadonlyArray<RecordedApproval>>([]);
        const movedLabels = yield* Ref.make<ItemLabelMutation | null>(null);
        const overviewReads = yield* Ref.make(0);
        const projectionRevision = yield* Ref.make(Option.some(ProjectionRevision.make(1)));
        yield* Effect.gen(function* () {
          const operator = yield* Operator;
          const rejected = (target: Repository.Name, item: number, toLane: string) =>
            operator
              .moveBoardItem(
                instance,
                new BoardMove({
                  repository: target,
                  item: Item.Number.make(item),
                  toLane: BoardLaneId.make(toLane),
                }),
              )
              .pipe(Effect.flip);
          const unknownProject = yield* rejected(
            Repository.Name.make("basaltbytes/elsewhere"),
            31,
            "authored:In review",
          );
          assert.strictEqual(unknownProject._tag, "BoardProjectNotFoundError");
          const unknownItem = yield* rejected(repository, 404, "authored:In review");
          assert.strictEqual(unknownItem._tag, "BoardItemNotFoundError");
          const unknownLane = yield* rejected(repository, 31, "authored:Nowhere");
          assert.strictEqual(unknownLane._tag, "BoardLaneNotFoundError");
          const stateLane = yield* rejected(repository, 31, "fallback:unmapped");
          assert.strictEqual(stateLane._tag, "BoardLaneReadOnlyError");
          assert.strictEqual(yield* Ref.get(movedLabels), null);
        }).pipe(
          Effect.provide(testLayer(approved, movedLabels, overviewReads, projectionRevision)),
        );
      }),
  );

  it("removes nested infrastructure defect causes from operator failure schemas", () => {
    const secret = "token=super-secret";
    const view = failureView(
      new AttemptFailure.InfraFailure({
        message: "The worker connection failed",
        cause: new Error(secret),
      }),
    );
    const encoded = Schema.encodeUnknownSync(FailureView)(view);
    const json = JSON.stringify(encoded);

    assert.deepStrictEqual(encoded, {
      _tag: "InfraFailure",
      message: "The worker connection failed",
    });
    assert.strictEqual(json.includes("cause"), false);
    assert.strictEqual(json.includes(secret), false);
  });
});
