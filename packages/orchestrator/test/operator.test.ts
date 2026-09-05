import { assert, describe, it } from "@effect/vitest";
import {
  CycleBudgetAsk,
  CycleBudgetAskId,
  CycleCount,
  CycleLimit,
  LoopCycleCount,
} from "@usine/core/cycle-budget";
import { CycleBudgets } from "@usine/engine/cycle-budget";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AgentName, Agent, AgentPersona } from "@usine/core/agent";
import { AttemptId, Attempt, AttemptNumber, AttemptTask } from "@usine/core/attempt";
import { DedupKey, EventId, Event } from "@usine/core/event";
import { ItemKey, ItemNumber as CoreItemNumber, ItemNumber } from "@usine/core/item";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { RunId, Run } from "@usine/core/run";
import { StepName, Step } from "@usine/core/step";
import { WorkerName } from "@usine/core/worker";
import { AgentFile } from "@usine/config/agent";
import { GitHubLabelName } from "@usine/config/label";
import { IssueTrigger } from "@usine/config/trigger";
import { LoadedInstance } from "@usine/config/instance";
import { LoopFile, PromptTemplate } from "@usine/config/loop";
import { LoopName } from "@usine/core/loop";
import { UsineConfig } from "@usine/config/factory";
import {
  AgentSessionId,
  ChildSession,
  ParentSession,
  TextOutput,
  ToolStarted,
} from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { InfraFailure } from "@usine/core/attempt/failure";
import * as RunState from "@usine/core/run/state";
import { RunEngine } from "@usine/engine/engine";
import {
  ItemContentHash,
  ItemProjection,
  ItemProjectionSource,
  ItemProjectionReader,
} from "@usine/engine/item-projection";
import { LoopControl, LoopRuntimeState } from "@usine/engine/loop-control";
import { ProjectionRevision, RunSnapshot, RunReader } from "@usine/engine/run-reader";
import {
  TranscriptEntry,
  type TranscriptQuery,
  TranscriptSequence,
} from "@usine/engine/transcript";
import { RepositoryLabelProjectionReader } from "@usine/engine/repository-label-projection";
import { GitHubItemWriter, type ItemLabelMutation } from "@usine/github/item-writer";
import { Source } from "@usine/expression/expression-engine";
import { DateTime, Effect, Layer, Match, Option, Ref, Schema } from "effect";
import { LabelPreflightFinding } from "../src/label-reconciler.ts";
import { BoardLaneId, BoardMove } from "../src/operator/board.ts";
import {
  ColdTranscriptRequest,
  EarlierTranscriptRequest,
  TailTranscriptRequest,
} from "../src/operator/transcript.ts";
import { FailureView } from "../src/operator/attempt.ts";
import { Operator } from "../src/operator/operator.ts";
import { PollCycle, PollingTriggers, RepositoryPollFailure } from "../src/polling-triggers.ts";
import { ScheduleCycle, ScheduleTriggers } from "../src/schedule-triggers.ts";
import { failureView } from "../src/operator/projection.ts";
import { noCycleBudgets } from "./support/polling.ts";

const now = DateTime.makeUnsafe("2026-08-31T12:00:00.000Z");
const runId = RunId.make("run-operator-test");
const attemptId = AttemptId.make("attempt-operator-test");
const loopName = LoopName.make("review-issue");
const repository = RepositoryName.make("basaltbytes/usine");
const itemKey = ItemKey.make("github:basaltbytes/usine:31");
const brain = new BrainSpec({
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
  persona: AgentPersona.make("Review the issue."),
});
const loop = new LoopFile({
  name: loopName,
  trigger: new IssueTrigger({ on: "issue", if: Source.make("true") }),
  selector: Option.none(),
  approval: "required",
  step: StepName.make("run"),
  agent: agentFile.name,
  body: PromptTemplate.make("Review it."),
});
const instance = new LoadedInstance({
  config,
  agents: [agentFile],
  invalidAgents: [],
  loops: [loop],
  quarantinedLoops: [],
  warnings: [],
});

const snapshot = new RunSnapshot({
  event: new Event({
    id: EventId.make("event-operator-test"),
    dedupKey: DedupKey.make("event-operator-test"),
    payload: { number: 31 },
    receivedAt: now,
  }),
  itemKey,
  run: new Run({
    id: runId,
    eventId: EventId.make("event-operator-test"),
    loop: loopName,
    state: new RunState.Waiting(),
    openedAt: now,
  }),
  step: new Step({
    runId,
    name: StepName.make("run"),
    result: Option.none(),
  }),
  attempts: [
    new Attempt({
      id: attemptId,
      runId,
      stepName: StepName.make("run"),
      worker: WorkerName.make("local"),
      number: AttemptNumber.make(1),
      brain,
      parentModel: Option.none(),
      startedAt: now,
      outcome: Option.none(),
    }),
  ],
  repository,
  revision: RepositoryRevision.make("main"),
  task: AttemptTask.make("Review issue 31."),
  agent: new Agent({
    name: agentFile.name,
    brain,
    parentModel: Option.none(),
    parentEffort: Option.none(),
    persona: agentFile.persona,
  }),
  parentModel: Option.none(),
});

const parent = new ParentSession({
  id: AgentSessionId.make("parent-session"),
  agent: agentFile.name,
  brain,
});
const child = new ChildSession({
  id: AgentSessionId.make("child-session"),
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
      version: AttemptChannel.PROTOCOL_VERSION,
      attemptId,
      sequence: AttemptChannel.Sequence.make(1),
      sentAt: now,
      payload: new AttemptChannel.SessionEvent({
        event: new TextOutput({ session: parent, text: "Parent update" }),
      }),
    }),
    receivedAt: now,
  }),
  new TranscriptEntry({
    sequence: TranscriptSequence.make(2),
    attemptId,
    direction: "outbound",
    envelope: new AttemptChannel.OutboundEnvelope({
      version: AttemptChannel.PROTOCOL_VERSION,
      attemptId,
      sequence: AttemptChannel.Sequence.make(2),
      sentAt: now,
      payload: new AttemptChannel.SessionEvent({
        event: new ToolStarted({
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
        version: AttemptChannel.PROTOCOL_VERSION,
        attemptId,
        sequence: AttemptChannel.Sequence.make(sequence),
        sentAt: now,
        payload: new AttemptChannel.SessionEvent({
          event: new TextOutput({
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
  readonly runId: RunId;
  readonly event: Event;
}

const testLayer = (
  approved: Ref.Ref<ReadonlyArray<RecordedApproval>>,
  movedLabels: Ref.Ref<ItemLabelMutation | null>,
  overviewReads: Ref.Ref<number>,
  projectionRevision: Ref.Ref<Option.Option<ProjectionRevision>>,
  runSnapshot: RunSnapshot = snapshot,
  budgets: Layer.Layer<CycleBudgets> = noCycleBudgets,
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
    inspect: () => Effect.succeed(runSnapshot),
    reconcile: () => Effect.void,
    retry: () => Effect.void,
    revoke: () => Effect.succeed([]),
    submit: () => Effect.die("unused"),
    transcript: readTranscript,
  });
  const reader = Layer.succeed(RunReader)({
    inspect: () => Effect.succeed(runSnapshot),
    list: () =>
      Ref.updateAndGet(overviewReads, (reads) => reads + 1).pipe(
        Effect.andThen(Effect.yieldNow),
        Effect.as([runSnapshot]),
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
          itemKey: ItemKey.make("github:basaltbytes/usine:32"),
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
          preflightFindings: [
            new LabelPreflightFinding({
              repository,
              label: GitHubLabelName.make("ready-for-review"),
              errorTag: "GitHubApiError",
              message: "GitHub rejected the request with status 500",
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
    budgets,
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
  it.effect("projects Item-level exhaustion without a new Run and answers the exact Ask", () =>
    Effect.gen(function* () {
      const ask = new CycleBudgetAsk({
        id: CycleBudgetAskId.make("exhausted-round"),
        itemKey,
        repository,
        loop: loopName,
        limit: CycleLimit.make(3),
        counts: [
          new LoopCycleCount({
            loop: loopName,
            admitted: CycleCount.make(3),
            completed: CycleCount.make(3),
          }),
        ],
      });
      const asks = yield* Ref.make<ReadonlyArray<CycleBudgetAsk>>([ask]);
      const answered = yield* Ref.make<
        ReadonlyArray<{ readonly id: CycleBudgetAskId; readonly event: Event }>
      >([]);
      const approved = yield* Ref.make<ReadonlyArray<RecordedApproval>>([]);
      const moved = yield* Ref.make<ItemLabelMutation | null>(null);
      const reads = yield* Ref.make(0);
      const revision = yield* Ref.make(Option.some(ProjectionRevision.make(1)));
      const budgets = Layer.succeed(CycleBudgets)({
        asks: () => Ref.get(asks),
        pendingResets: () => Effect.succeed([]),
        acknowledgeReset: () => Effect.die("unused"),
        reset: (id, event) =>
          Effect.gen(function* () {
            yield* Ref.update(answered, (values) => [...values, { id, event }]);
            yield* Ref.set(asks, []);
            yield* Ref.set(revision, Option.some(ProjectionRevision.make(2)));
          }),
      });
      yield* Effect.gen(function* () {
        const operator = yield* Operator;
        const overview = yield* operator.overview(instance);
        const need = overview.needsYou.find((need) => need._tag === "CycleBudgetNeed");
        assert(need?._tag === "CycleBudgetNeed");
        assert.deepStrictEqual(need.ask, ask);
        assert.strictEqual(overview.projects[0]?.status, "needs-you");
        assert(
          overview.projects[0]?.board.lanes.some((lane) =>
            lane.items.some((card) => card.itemKey === itemKey && card.needsYou),
          ),
        );
        yield* operator.resetCycleBudget(ask.id);
        const answers = yield* Ref.get(answered);
        assert.strictEqual(answers[0]?.id, ask.id);
        assert.strictEqual(answers[0]?.event.id, `cycle-budget-reset:${ask.id}`);
        const refreshed = yield* operator.overview(instance);
        assert(!refreshed.needsYou.some((need) => need._tag === "CycleBudgetNeed"));
      }).pipe(Effect.provide(testLayer(approved, moved, reads, revision, snapshot, budgets)));
    }),
  );

  it.effect(
    "rejects approving a Run that already left its gate and keeps it out of needs-you",
    () =>
      Effect.gen(function* () {
        const approved = yield* Ref.make<ReadonlyArray<RecordedApproval>>([]);
        const movedLabels = yield* Ref.make<ItemLabelMutation | null>(null);
        const overviewReads = yield* Ref.make(0);
        const projectionRevision = yield* Ref.make(Option.some(ProjectionRevision.make(1)));
        const queued = new RunSnapshot({
          ...snapshot,
          run: new Run({ ...snapshot.run, state: new RunState.Queued() }),
        });
        yield* Effect.gen(function* () {
          const operator = yield* Operator;
          const rejected = yield* operator.approve(runId).pipe(Effect.flip);
          assert(rejected._tag === "RunOperationRejectedError");
          assert.strictEqual(rejected.state, "Queued");
          assert.deepStrictEqual(yield* Ref.get(approved), []);

          const overview = yield* operator.overview(instance);
          assert(overview._tag === "Ready");
          const run = overview.projects[0]?.runs[0];
          assert(run !== undefined);
          assert.strictEqual(run.state, "Queued");
          assert.strictEqual(run.canApprove, false);
          assert.strictEqual(run.canCancel, true);
          // The fixture's malformed Item, poll failure, and preflight finding still need the
          // operator; the Run does not.
          assert.deepStrictEqual(
            overview.needsYou.map((need) => need._tag),
            ["BoardProjectionNeed", "PollFailureNeed", "PreflightFindingNeed"],
          );
        }).pipe(
          Effect.provide(
            testLayer(approved, movedLabels, overviewReads, projectionRevision, queued),
          ),
        );
      }),
  );

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
        assert.strictEqual(overview.projects[0]?.preflightFindings[0]?.label, "ready-for-review");
        assert.strictEqual(
          overview.projects[0]?.board.failures[0]?.itemKey,
          "github:basaltbytes/usine:32",
        );
        assert.deepStrictEqual(
          overview.needsYou.map(({ _tag }) => _tag),
          ["ApprovalNeed", "BoardProjectionNeed", "PollFailureNeed", "PreflightFindingNeed"],
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
          new TailTranscriptRequest({ after: TranscriptSequence.make(1) }),
        );
        assert.strictEqual(tail.transcript.length, 500);
        assert.strictEqual(tail.transcript[0]?.sequence, 2);
        assert.strictEqual(tail.transcript.at(-1)?.sequence, 501);
        assert.deepStrictEqual(tail.earlierTranscript, []);
        const remainingTail = yield* operator.detail(
          runId,
          new TailTranscriptRequest({ after: TranscriptSequence.make(501) }),
        );
        assert.deepStrictEqual(
          remainingTail.transcript.map(({ sequence }) => sequence),
          [502],
        );

        const earlier = yield* operator.detail(
          runId,
          new EarlierTranscriptRequest({
            attemptId,
            before: TranscriptSequence.make(3),
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
              attemptId: AttemptId.make("another-attempt"),
              before: TranscriptSequence.make(3),
            }),
          )
          .pipe(Effect.flip);
        assert.strictEqual(wrongAttempt._tag, "TranscriptAttemptNotFoundError");

        yield* operator.approve(runId);
        const approvals = yield* Ref.get(approved);
        const recorded = approvals[0];
        assert(recorded !== undefined);
        assert.strictEqual(recorded.runId, runId);
        // The approval Event the waiting run consumes is recorded whole: a
        // deterministic identity for idempotent re-approval and a typed payload.
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
            item: CoreItemNumber.make(31),
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
          const rejected = (target: RepositoryName, item: number, toLane: string) =>
            operator
              .moveBoardItem(
                instance,
                new BoardMove({
                  repository: target,
                  item: CoreItemNumber.make(item),
                  toLane: BoardLaneId.make(toLane),
                }),
              )
              .pipe(Effect.flip);
          const unknownProject = yield* rejected(
            RepositoryName.make("basaltbytes/elsewhere"),
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
      new InfraFailure({
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
