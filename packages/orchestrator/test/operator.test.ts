import { CycleGeneration } from "@usine/core/cycle-budget";
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
import {
  AttemptId,
  Attempt,
  AttemptNumber,
  AttemptContext,
  AttemptTask,
} from "@usine/core/attempt";
import { DedupKey, EventId, Event } from "@usine/core/event";
import { ItemKey, ItemNumber as CoreItemNumber, ItemNumber } from "@usine/core/item";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { RunId, Run } from "@usine/core/run";
import { ApprovalSource, RunApproval } from "@usine/core/run/approval";
import { StepName, Step } from "@usine/core/step";
import { WorkerName } from "@usine/core/worker";
import { AgentFile, InvalidAgent } from "@usine/config/agent";
import { ConfigFileError, InstancePath } from "@usine/config/file";
import { GitHubLabelName } from "@usine/config/label";
import { IssueTrigger } from "@usine/config/trigger";
import { LoadedInstance } from "@usine/config/instance";
import { LoopFile, PromptTemplate, QuarantinedLoop } from "@usine/config/loop";
import { LoopName } from "@usine/core/loop";
import { UsineConfig } from "@usine/config/factory";
import { OperatorLogin } from "@usine/core/operator";
import {
  AgentSessionId,
  ChildSession,
  ParentSession,
  TextOutput,
  ToolStarted,
} from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { DefectFailure, InfraFailure } from "@usine/core/attempt/failure";
import { AttemptFailed } from "@usine/core/attempt/outcome";
import * as RunState from "@usine/core/run/state";
import { RunEngine } from "@usine/engine/engine";
import {
  ItemContentHash,
  ItemProjection,
  ItemProjectionSource,
  ItemProjectionReader,
} from "@usine/engine/item-projection";
import { LoopControl, LoopRuntimeState } from "@usine/engine/loop-control";
import {
  ProjectionRevision,
  RunSnapshot,
  RunReader,
  WorkerAttempts,
} from "@usine/engine/run-reader";
import {
  TranscriptEntry,
  type TranscriptQuery,
  TranscriptSequence,
} from "@usine/engine/transcript";
import {
  RepositoryLabelProjection,
  RepositoryLabelProjectionReader,
} from "@usine/engine/repository-label-projection";
import { GitHubItemHistory } from "@usine/github/item-history";
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
import { ReadyOverview } from "../src/operator/overview.ts";
import { ApprovalView, EditAndRetry, SessionIntervention } from "../src/operator/run.ts";
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
  resolvedFailureAttemptId: Option.none(),
  approval: Option.none(),
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
      task: AttemptTask.make("Review issue 31."),
      agent: agentFile.name,
      operatorIntervened: false,
      id: attemptId,
      runId,
      stepName: StepName.make("run"),
      worker: WorkerName.make("local"),
      number: AttemptNumber.make(1),
      brain,
      parentModel: Option.none(),
      startedAt: now,
      outcome: Option.none(),
      endedAt: Option.none(),
      salvage: Option.none(),
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
  readonly source: ApprovalSource;
}

const testLayer = (
  approved: Ref.Ref<ReadonlyArray<RecordedApproval>>,
  movedLabels: Ref.Ref<ItemLabelMutation | null>,
  overviewReads: Ref.Ref<number>,
  projectionRevision: Ref.Ref<Option.Option<ProjectionRevision>>,
  runSnapshot: RunSnapshot = snapshot,
  budgets: Layer.Layer<CycleBudgets> = noCycleBudgets,
  commands: Pick<RunEngine["Service"], "retry" | "intervene"> = {
    retry: () => Effect.void,
    intervene: () => Effect.void,
  },
) => {
  const readTranscript = (query: TranscriptQuery) =>
    Effect.succeed(
      Match.valueTags(query, {
        TranscriptAllQuery: () => transcript,
        TranscriptSessionsQuery: () => [],
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
    resolveFailure: () => Effect.void,
    intervene: commands.intervene,
    approve: (id, event, source) =>
      Ref.update(approved, (entries) => [...entries, { runId: id, event, source }]),
    cancel: () => Effect.void,
    discardLeftovers: () => Effect.die("unused"),
    inspect: () => Effect.succeed(runSnapshot),
    reconcile: () => Effect.void,
    drain: () => Effect.void,
    retry: commands.retry,
    revoke: () => Effect.succeed([]),
    submit: () => Effect.die("unused"),
    transcript: readTranscript,
  });
  const reader = Layer.succeed(RunReader)({
    inspect: () => Effect.succeed(runSnapshot),
    evidence: () => Effect.die("unused"),
    list: () =>
      Ref.updateAndGet(overviewReads, (reads) => reads + 1).pipe(
        Effect.andThen(Effect.yieldNow),
        Effect.as([runSnapshot]),
      ),
    forItems: () => Effect.succeed([runSnapshot]),
    revision: () => Ref.get(projectionRevision),
    transcript: readTranscript,
    attemptsByWorker: () =>
      Effect.succeed([new WorkerAttempts({ worker: WorkerName.make("local"), attempts: 3 })]),
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
              totalCount: 3,
              nodes: [{ name: "ready" }, { name: "bug" }, { name: "documentation" }],
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
    get: () =>
      Effect.succeed(
        Option.some(
          Schema.decodeUnknownSync(RepositoryLabelProjection)({
            repository,
            labels: ["ready", "ready-for-review", "bug", "documentation"].map((name) => ({
              name,
              color: null,
              description: null,
            })),
          }),
        ),
      ),
  });
  const github = Layer.succeed(GitHubItemWriter)({
    updateLabels: (_repository, _item, mutation) =>
      Ref.set(movedLabels, mutation).pipe(Effect.as(mutation.add)),
  });
  const polling = Layer.succeed(PollingTriggers)({
    hint: () =>
      Ref.get(movedLabels).pipe(
        Effect.flatMap((mutation) =>
          mutation === null
            ? Effect.die("A rejected Board destination must not fetch GitHub")
            : Effect.void,
        ),
      ),
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
  const history = Layer.succeed(GitHubItemHistory)({
    appChanges: () => Effect.die("unused"),
  });
  const dependencies = Layer.mergeAll(
    budgets,
    runs,
    reader,
    controls,
    github,
    history,
    itemReader,
    repositoryLabelReader,
    polling,
    schedules,
  );
  return Operator.layer.pipe(Layer.provide(dependencies));
};

describe("Operator", () => {
  it.effect("clears only resolved failure attention and renews it for a later failed Attempt", () =>
    Effect.gen(function* () {
      const approved = yield* Ref.make<ReadonlyArray<RecordedApproval>>([]);
      const moved = yield* Ref.make<ItemLabelMutation | null>(null);
      const reads = yield* Ref.make(0);
      const revision = yield* Ref.make(Option.some(ProjectionRevision.make(1)));
      const original = snapshot.attempts[0];
      assert(original !== undefined);
      const failed = new Attempt({
        ...original,
        outcome: Option.some(
          new AttemptFailed({
            failure: new InfraFailure({ message: "Worker unavailable", cause: "disconnected" }),
          }),
        ),
      });
      const later = new Attempt({
        ...failed,
        id: AttemptId.make("later-failure"),
        number: AttemptNumber.make(2),
      });
      for (const [attempts, resolved, needsAttention] of [
        [[failed], Option.none<AttemptId>(), true],
        [[failed], Option.some(failed.id), false],
        [[failed, later], Option.some(failed.id), true],
      ] as const) {
        const current = new RunSnapshot({
          ...snapshot,
          run: new Run({ ...snapshot.run, state: new RunState.Failed() }),
          attempts,
          resolvedFailureAttemptId: resolved,
        });
        yield* Effect.gen(function* () {
          const operator = yield* Operator;
          const overview = yield* operator.overview(instance);
          assert.strictEqual(
            overview.needsYou.some((need) => need._tag === "RunFailureNeed"),
            needsAttention,
          );
          assert.deepStrictEqual(
            overview.needsYou
              .filter((need) => need._tag !== "RunFailureNeed")
              .map((need) => need._tag),
            ["BoardProjectionNeed", "PollFailureNeed", "PreflightFindingNeed"],
          );
          const card = overview.projects[0]?.board.lanes
            .flatMap((lane) => lane.items)
            .find((item) => item.itemKey === itemKey);
          assert.strictEqual(card?.needsYou, needsAttention);
          assert.strictEqual(overview.projects[0]?.status, "needs-you");
          const detail = yield* operator.detail(runId);
          assert.strictEqual(detail.run.canResolveFailure, needsAttention);
          assert.strictEqual(detail.run.canRetry, true);
          assert.strictEqual(detail.run.state, "Failed");
        }).pipe(Effect.provide(testLayer(approved, moved, reads, revision, current)));
      }
    }),
  );

  it.effect("projects when each Attempt on a Board card started and when a closed one ended", () =>
    Effect.gen(function* () {
      const approved = yield* Ref.make<ReadonlyArray<RecordedApproval>>([]);
      const moved = yield* Ref.make<ItemLabelMutation | null>(null);
      const reads = yield* Ref.make(0);
      const revision = yield* Ref.make(Option.some(ProjectionRevision.make(1)));
      const original = snapshot.attempts[0];
      assert(original !== undefined);
      const failed = new Attempt({
        ...original,
        outcome: Option.some(
          new AttemptFailed({
            failure: new InfraFailure({ message: "Worker unavailable", cause: "disconnected" }),
          }),
        ),
        endedAt: Option.some(DateTime.add(now, { minutes: 5 })),
      });
      const running = new Attempt({
        ...original,
        id: AttemptId.make("running-retry"),
        number: AttemptNumber.make(2),
        startedAt: DateTime.add(now, { minutes: 6 }),
      });
      const current = new RunSnapshot({
        ...snapshot,
        run: new Run({ ...snapshot.run, state: new RunState.Running() }),
        attempts: [failed, running],
      });
      yield* Effect.gen(function* () {
        const operator = yield* Operator;
        const overview = yield* operator.overview(instance);
        const card = overview.projects[0]?.board.lanes
          .flatMap((lane) => lane.items)
          .find((item) => item.itemKey === itemKey);
        assert.deepStrictEqual(
          card?.run?.attempts.map(({ startedAt, endedAt }) => ({ startedAt, endedAt })),
          [
            { startedAt: "2026-08-31T12:00:00.000Z", endedAt: "2026-08-31T12:05:00.000Z" },
            { startedAt: "2026-08-31T12:06:00.000Z", endedAt: null },
          ],
        );
      }).pipe(Effect.provide(testLayer(approved, moved, reads, revision, current)));
    }),
  );

  it.effect(
    "derives retry context from the selected roster agent and attributes input to the configured operator",
    () =>
      Effect.gen(function* () {
        const approved = yield* Ref.make<ReadonlyArray<RecordedApproval>>([]);
        const moved = yield* Ref.make<ItemLabelMutation | null>(null);
        const reads = yield* Ref.make(0);
        const revision = yield* Ref.make(Option.some(ProjectionRevision.make(1)));
        const edits: Array<AttemptContext> = [];
        const inputs: Array<AttemptChannel.Intervention> = [];
        const replacement = new AgentFile({
          ...agentFile,
          name: AgentName.make("reviewer"),
          harness: "codex",
          model: ModelId.make("new-model"),
          persona: AgentPersona.make("Review the implementation"),
          parentModel: Option.some(ModelId.make("openai/new-parent")),
          parentEffort: Option.some("medium"),
        });
        const configured = new LoadedInstance({
          ...instance,
          config: new UsineConfig({
            ...instance.config,
            operator: Option.some(OperatorLogin.make("Philippe")),
          }),
          agents: [agentFile, replacement],
        });
        yield* Effect.gen(function* () {
          const operator = yield* Operator;
          yield* operator.editAndRetry(
            configured,
            runId,
            new EditAndRetry({
              task: AttemptTask.make("Correct the failed approach"),
              agent: replacement.name,
            }),
          );
          assert.deepStrictEqual(edits, [
            new AttemptContext({
              task: AttemptTask.make("Correct the failed approach"),
              agent: replacement.agent,
              parentModel: replacement.parentModel,
            }),
          ]);
          const refused = yield* Effect.flip(
            operator.editAndRetry(
              configured,
              runId,
              new EditAndRetry({
                task: AttemptTask.make("Task"),
                agent: AgentName.make("missing"),
              }),
            ),
          );
          assert.strictEqual(refused._tag, "RosterAgentNotFoundError");
          assert.strictEqual(edits.length, 1);
          const input = Schema.decodeUnknownSync(SessionIntervention)({
            attemptId,
            action: { _tag: "Steer", message: "Continue" },
          });
          assert.strictEqual(input.target._tag, "Parent");
          yield* operator.intervene(configured, runId, input);
          assert.deepStrictEqual(inputs, [
            new AttemptChannel.Intervention({
              operator: "Philippe",
              target: new AttemptChannel.ParentTarget(),
              action: input.action,
            }),
          ]);
        }).pipe(
          Effect.provide(
            testLayer(approved, moved, reads, revision, snapshot, noCycleBudgets, {
              retry: (_runId, edit) =>
                Effect.sync(() => {
                  if (edit !== undefined && Option.isSome(edit)) edits.push(edit.value);
                }),
              intervene: (_runId, _attemptId, input) =>
                Effect.sync(() => {
                  inputs.push(input);
                }),
            }),
          ),
        );
      }),
  );

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
        generation: () => Effect.succeed(CycleGeneration.make(0)),
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
        const askAnswer = new ApprovalSource({
          channel: "github-ask",
          approver: Option.some(OperatorLogin.make("Philippe")),
        });
        const queued = new RunSnapshot({
          ...snapshot,
          run: new Run({ ...snapshot.run, state: new RunState.Queued() }),
          approval: Option.some(
            new RunApproval({ approvedAt: now, source: Option.some(askAnswer) }),
          ),
        });
        yield* Effect.gen(function* () {
          const operator = yield* Operator;
          const rejected = yield* operator.approve(instance, runId).pipe(Effect.flip);
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
          // The overview and the detail both say who approved, when, and from where.
          const shown = new ApprovalView({
            approvedAt: DateTime.formatIso(now),
            source: askAnswer,
          });
          assert.deepStrictEqual(run.approval, shown);
          assert.deepStrictEqual((yield* operator.detail(runId)).run.approval, shown);
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
        // The approval names the Item its Run works on, as the card shows it.
        const approval = overview.needsYou[0];
        assert(approval?._tag === "ApprovalNeed");
        assert.deepStrictEqual(
          approval.item,
          overview.projects[0]?.board.lanes[0]?.items[0]?.items[0],
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

        assert.strictEqual(overview.projects[0]?.runs[0]?.approval, null);
        const configured = new LoadedInstance({
          ...instance,
          config: new UsineConfig({
            ...instance.config,
            operator: Option.some(OperatorLogin.make("Philippe")),
          }),
        });
        yield* operator.approve(configured, runId);
        const approvals = yield* Ref.get(approved);
        const recorded = approvals[0];
        assert(recorded !== undefined);
        assert.strictEqual(recorded.runId, runId);
        // The UI has no sign-in, so it approves as the operator `usine.yaml` names.
        assert.deepStrictEqual(
          recorded.source,
          new ApprovalSource({
            channel: "ui",
            approver: Option.some(OperatorLogin.make("Philippe")),
          }),
        );
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
    "rejects Board moves onto unknown destinations and read-only lanes before writing labels",
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
          const proposed = new LoadedInstance({
            ...instance,
            config: Schema.decodeUnknownSync(UsineConfig)({
              version: 1,
              repos: [{ name: repository }],
            }),
          });
          const proposedLane = yield* operator
            .moveBoardItem(
              proposed,
              new BoardMove({
                repository,
                item: CoreItemNumber.make(31),
                toLane: BoardLaneId.make("proposed:ready-for-review"),
              }),
            )
            .pipe(Effect.flip);
          assert.strictEqual(proposedLane._tag, "BoardLaneReadOnlyError");
          assert.strictEqual(yield* Ref.get(movedLabels), null);
        }).pipe(
          Effect.provide(testLayer(approved, movedLabels, overviewReads, projectionRevision)),
        );
      }),
  );

  it.effect("lists quarantined Loops and invalid Agent files in Needs you", () =>
    Effect.gen(function* () {
      const approved = yield* Ref.make<ReadonlyArray<RecordedApproval>>([]);
      const moved = yield* Ref.make<ItemLabelMutation | null>(null);
      const reads = yield* Ref.make(0);
      const revision = yield* Ref.make(Option.some(ProjectionRevision.make(1)));
      const fileError = (file: string, stage: "schema" | "reference", message: string) =>
        new ConfigFileError({
          file: InstancePath.make(file),
          stage,
          expression: Option.none(),
          message,
        });
      const broken = new LoadedInstance({
        ...instance,
        invalidAgents: [
          new InvalidAgent({
            file: InstancePath.make("agents/intern.md"),
            error: fileError("agents/intern.md", "schema", "Expected a known harness"),
          }),
        ],
        quarantinedLoops: [
          new QuarantinedLoop({
            file: InstancePath.make("loops/ghost.md"),
            error: fileError("loops/ghost.md", "reference", "Unknown agent: ghost"),
          }),
        ],
      });
      const overview = yield* Effect.gen(function* () {
        const operator = yield* Operator;
        const before = yield* operator.overview(instance);
        assert.isFalse(before.needsYou.some((need) => need._tag === "ConfigFileNeed"));
        // A reload that only leaves files out still replaces the cached overview.
        return yield* operator.overview(broken);
      }).pipe(Effect.provide(testLayer(approved, moved, reads, revision)));
      const needs = overview.needsYou.filter((need) => need._tag === "ConfigFileNeed");
      assert.deepStrictEqual(
        needs.map(({ id, kind, error }) => [id, kind, error.file, error.stage, error.message]),
        [
          [
            "config-file:agents/intern.md",
            "agent",
            "agents/intern.md",
            "schema",
            "Expected a known harness",
          ],
          [
            "config-file:loops/ghost.md",
            "loop",
            "loops/ghost.md",
            "reference",
            "Unknown agent: ghost",
          ],
        ],
      );
      const encoded = Schema.encodeUnknownSync(ReadyOverview)(overview);
      assert.deepStrictEqual(
        Schema.decodeUnknownSync(ReadyOverview)(encoded).needsYou.filter(
          (need) => need._tag === "ConfigFileNeed",
        ),
        needs,
      );
    }),
  );

  it.effect("lists the Attempts of a Worker that usine.yaml no longer declares once", () =>
    Effect.gen(function* () {
      const approved = yield* Ref.make<ReadonlyArray<RecordedApproval>>([]);
      const moved = yield* Ref.make<ItemLabelMutation | null>(null);
      const reads = yield* Ref.make(0);
      const revision = yield* Ref.make(Option.some(ProjectionRevision.make(1)));
      const unconfiguredNeeds = (current: LoadedInstance) =>
        Effect.flatMap(Operator, (operator) => operator.overview(current)).pipe(
          Effect.provide(testLayer(approved, moved, reads, revision)),
          Effect.map(({ needsYou }) =>
            needsYou.filter((need) => need._tag === "UnconfiguredWorkerNeed"),
          ),
        );
      // The reader reports three Attempts on `local`, the Worker `instance` declares.
      assert.deepStrictEqual(yield* unconfiguredNeeds(instance), []);
      const switched = new LoadedInstance({
        ...instance,
        config: Schema.decodeUnknownSync(UsineConfig)({
          version: 1,
          repos: [{ name: repository }],
          workers: [{ name: "laptop", kind: "local" }],
        }),
      });
      const needs = yield* unconfiguredNeeds(switched);
      assert.deepStrictEqual(
        needs.map(({ id, worker, attempts }) => [id, worker, attempts]),
        [["unconfigured-worker:local", "local", 3]],
      );
      const encoded = Schema.encodeUnknownSync(ReadyOverview)(
        new ReadyOverview({ projects: [], loops: [], needsYou: needs }),
      );
      assert.deepStrictEqual(Schema.decodeUnknownSync(ReadyOverview)(encoded).needsYou, needs);
    }),
  );

  it.each([InfraFailure, DefectFailure])(
    "removes original causes from operator failure schemas: %s",
    (Failure) => {
      const secret = "token=super-secret";
      const view = failureView(
        new Failure({
          message: "The worker connection failed",
          cause: new Error(secret),
        }),
      );
      const encoded = Schema.encodeUnknownSync(FailureView)(view);
      const json = JSON.stringify(encoded);

      assert.deepStrictEqual(encoded, {
        _tag: Failure === InfraFailure ? "InfraFailure" : "DefectFailure",
        message: "The worker connection failed",
      });
      assert.strictEqual(json.includes("cause"), false);
      assert.strictEqual(json.includes(secret), false);
    },
  );
});
