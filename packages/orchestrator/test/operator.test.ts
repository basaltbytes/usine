import { CycleGeneration } from "@usine/core/cycle-budget";
import { assert, describe, it } from "@effect/vitest";
import {
  CycleBudgetAsk,
  CycleBudgetAskId,
  CycleCount,
  CycleLimit,
  LoopCycleCount,
} from "@usine/core/cycle-budget";
import { type BoardMoveRecord, BoardMoves } from "@usine/engine/board-moves";
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
import { SshDestination, WorkerName } from "@usine/core/worker";
import { AgentFile, InvalidAgent } from "@usine/config/agent";
import { ConfigFileError, InstancePath } from "@usine/config/file";
import { GitHubLabelName } from "@usine/config/label";
import { IssueTrigger, PullRequestTrigger } from "@usine/config/trigger";
import { LoadedInstance } from "@usine/config/instance";
import { LoopFile, PromptTemplate, QuarantinedLoop } from "@usine/config/loop";
import { LoopName } from "@usine/core/loop";
import { LocalWorker, UsineConfig } from "@usine/config/factory";
import { OperatorLogin } from "@usine/core/operator";
import {
  AgentSessionId,
  ChildSession,
  ParentSession,
  SessionTokensUpdated,
  TextOutput,
  TokenCount,
  ToolStarted,
  UsdAmount,
} from "@usine/core/agent/session";
import { StartedByEvent, StartedByInfraRetry } from "@usine/core/attempt/start";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { BlockedFailure, DefectFailure, InfraFailure } from "@usine/core/attempt/failure";
import { AttemptCanceled, AttemptFailed } from "@usine/core/attempt/outcome";
import * as RunState from "@usine/core/run/state";
import {
  Claimed,
  RunAgainRequest,
  RunEngine,
  UnconfirmedStop,
  UnconfirmedStops,
} from "@usine/engine/engine";
import {
  ItemContentHash,
  ItemProjection,
  ItemProjectionSource,
  ItemProjectionReader,
} from "@usine/engine/item-projection";
import { LoopControl, LoopRuntimeState } from "@usine/engine/loop-control";
import {
  ProjectionRevision,
  RunEvent,
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
import { FailureView, LocalWorkerAccess, SshWorkerAccess } from "../src/operator/attempt.ts";
import { UnconfiguredWorkerNeed } from "../src/operator/need.ts";
import { Operator } from "../src/operator/operator.ts";
import { ReadyOverview } from "../src/operator/overview.ts";
import { ApprovalView, EditAndRetry, SessionIntervention } from "../src/operator/run.ts";
import { PollCycle, PollingTriggers, RepositoryPollFailure } from "../src/polling-triggers.ts";
import { ScheduleCycle, ScheduleTriggers } from "../src/schedule-triggers.ts";
import { failureView, runDuration } from "../src/operator/projection.ts";
import { WorkerStatus } from "../src/worker-status.ts";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
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
  closedAt: Option.none(),
  approval: Option.none(),
  runAgain: Option.none(),
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
  permissions: "write",
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

const retryAttemptId = AttemptId.make("running-retry");
const sessionOf = (
  id: string,
  harness: BrainSpec["harness"],
  model: string,
  agent: string,
): ParentSession | ChildSession => {
  const sessionBrain = new BrainSpec({ harness, model: ModelId.make(model), effort: "high" });
  return harness === "pi"
    ? new ParentSession({ id: AgentSessionId.make(id), agent: agentFile.name, brain: sessionBrain })
    : new ChildSession({
        id: AgentSessionId.make(id),
        parentId: AgentSessionId.make(`parent-of-${id}`),
        agent: AgentName.make(agent),
        brain: sessionBrain,
      });
};
const apiParent = sessionOf("api-parent", "pi", "openai/gpt-5.5", "developer");
const claudeChild = sessionOf("claude-child", "claude", "claude-opus-4-7", "developer");
const planParent = sessionOf("plan-parent", "pi", "openai-codex/gpt-5.5", "developer");
const codexChild = sessionOf("codex-child", "codex", "gpt-5.6-sol", "reviewer");
/** A Claude Code child on the SSH Worker whose Gateway billed its model requests to an API key. */
const gatewayClaudeChild = new ChildSession({
  id: AgentSessionId.make("gateway-claude-child"),
  parentId: AgentSessionId.make("parent-of-gateway-claude-child"),
  agent: AgentName.make("developer"),
  brain: new BrainSpec({
    harness: "claude",
    model: ModelId.make("claude-opus-4-7"),
    effort: "high",
  }),
  gatewayCredential: Option.some("api-key"),
});
/**
 * Returns transcript row `sequence` of `attempt`, where `session` reports `tokens` so far at `usd`.
 */
const tokenReport = (
  attempt: AttemptId,
  session: ParentSession | ChildSession,
  tokens: number,
  usd: number | null,
  sequence: number,
) =>
  new TranscriptEntry({
    sequence: TranscriptSequence.make(sequence),
    attemptId: attempt,
    direction: "outbound",
    envelope: new AttemptChannel.OutboundEnvelope({
      version: AttemptChannel.PROTOCOL_VERSION,
      attemptId: attempt,
      sequence: AttemptChannel.Sequence.make(sequence),
      sentAt: now,
      payload: new AttemptChannel.SessionEvent({
        event: new SessionTokensUpdated({
          session,
          totalTokens: TokenCount.make(tokens),
          costUsd: usd === null ? Option.none() : Option.some(UsdAmount.make(usd)),
        }),
      }),
    }),
    receivedAt: now,
  });
/**
 * Returns the token reports that the usage query returns: each session's reports, including the
 * highest.
 */
const usageReports = (
  [
    [attemptId, apiParent, 1_000, 0.5],
    [attemptId, apiParent, 1_500, 0.75],
    [attemptId, claudeChild, 20_000, 1.25],
    [retryAttemptId, planParent, 800, 0.3],
    [retryAttemptId, codexChild, 5_000, null],
    [retryAttemptId, gatewayClaudeChild, 3_000, 0.25],
  ] as const
).map(([attempt, session, tokens, usd], index) =>
  tokenReport(attempt, session, tokens, usd, 1_000 + index),
);

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
  commands: Pick<RunEngine["Service"], "retry" | "intervene" | "runAgain"> = {
    retry: () => Effect.void,
    intervene: () => Effect.void,
    runAgain: () => Effect.die("unused"),
  },
  /** Receives the Attempt of each token-report query, in order. */
  usageQueries: Array<AttemptId> = [],
  /** Token reports a test adds while its Attempts run; the usage query also returns them. */
  laterReports: ReadonlyArray<TranscriptEntry> = [],
  /** Receives each Board move the operator records, in order. */
  recordedMoves: Array<BoardMoveRecord> = [],
  unconfirmedStops: Effect.Effect<ReadonlyArray<UnconfirmedStop>> = Effect.succeed([]),
) => {
  const readTranscript = (query: TranscriptQuery) =>
    Effect.succeed(
      Match.valueTags(query, {
        TranscriptAllQuery: () => transcript,
        TranscriptSessionsQuery: () => [],
        TranscriptUsageQuery: ({ attemptId: attempt }) => {
          usageQueries.push(attempt);
          return [...usageReports, ...laterReports].filter((entry) => entry.attemptId === attempt);
        },
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
    runAgain: commands.runAgain,
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
    closed: () => Effect.succeed([]),
    forItems: () => Effect.succeed([runSnapshot]),
    events: (runIds) =>
      Effect.succeed(
        runIds.includes(runSnapshot.run.id)
          ? [new RunEvent({ runId: runSnapshot.run.id, event: runSnapshot.event })]
          : [],
      ),
    revision: () => Ref.get(projectionRevision),
    transcript: readTranscript,
    attemptsByWorker: () =>
      Effect.succeed([
        new WorkerAttempts({ worker: WorkerName.make("local"), attempts: 3, running: 1 }),
      ]),
    sightings: () => Effect.succeed([]),
  });
  const controls = Layer.succeed(LoopControl)({
    isPaused: () => Effect.succeed(true),
    pause: () => Effect.succeed(new LoopRuntimeState({ loop: loopName, paused: true })),
    states: Effect.succeed([new LoopRuntimeState({ loop: loopName, paused: true })]),
    unpause: () => Effect.succeed(new LoopRuntimeState({ loop: loopName, paused: false })),
  });
  const itemReader = Layer.succeed(ItemProjectionReader)({
    openIssues: () => Effect.die("the operator does not check open issues"),
    get: () => Effect.succeed(Option.none()),
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
              message: "GitHub returned HTTP status 500",
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
  const boardMoves = Layer.succeed(BoardMoves)({
    record: (move) => Effect.sync(() => recordedMoves.push(move)),
    onItem: () => Effect.die("unused"),
  });
  const dependencies = Layer.mergeAll(
    budgets,
    runs,
    reader,
    controls,
    github,
    history,
    boardMoves,
    itemReader,
    repositoryLabelReader,
    polling,
    schedules,
    MarcbachmannCelLayer,
    WorkerStatus.idle,
    Layer.succeed(UnconfirmedStops)({ list: unconfirmedStops }),
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
          const detail = yield* operator.detail(instance, runId);
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

  it.effect("keeps a running Run's card in the lane its Event's labels routed to", () =>
    Effect.gen(function* () {
      const approved = yield* Ref.make<ReadonlyArray<RecordedApproval>>([]);
      const moved = yield* Ref.make<ItemLabelMutation | null>(null);
      const reads = yield* Ref.make(0);
      const revision = yield* Ref.make(Option.some(ProjectionRevision.make(1)));
      // Issue #31 has `ready` now; its Run was triggered while it had `ready-for-review`.
      const triggered = new Event({
        ...snapshot.event,
        payload: { number: 31, labels: { totalCount: 1, nodes: [{ name: "ready-for-review" }] } },
      });
      const laneOf = (overview: ReadyOverview): string | undefined =>
        overview.projects[0]?.board.lanes.find(({ items }) =>
          items.some((item) => item.itemKey === itemKey),
        )?.name;
      for (const [state, lane] of [
        [new RunState.Running(), "In review"],
        [new RunState.Waiting(), "Ready"],
      ] as const) {
        const current = new RunSnapshot({
          ...snapshot,
          event: triggered,
          run: new Run({ ...snapshot.run, state }),
        });
        const recordedMoves: Array<BoardMoveRecord> = [];
        yield* Effect.gen(function* () {
          const operator = yield* Operator;
          assert.strictEqual(laneOf(yield* operator.overview(instance)), lane);
          // A move records the lane the Board showed the card in.
          const toLane = lane === "Ready" ? "In review" : "Ready";
          yield* operator.moveBoardItem(
            instance,
            new BoardMove({
              repository,
              item: CoreItemNumber.make(31),
              toLane: BoardLaneId.make(`authored:${toLane}`),
            }),
          );
          assert.deepStrictEqual(
            recordedMoves.map(({ fromLane, toLane: recordedTo }) => [fromLane, recordedTo]),
            [[lane, toLane]],
          );
        }).pipe(
          Effect.provide(
            testLayer(
              approved,
              moved,
              reads,
              revision,
              current,
              noCycleBudgets,
              undefined,
              [],
              [],
              recordedMoves,
            ),
          ),
        );
      }
    }),
  );

  it("adds up Attempt time, ending an Attempt with no recorded end at its newest transcript row", () => {
    const original = snapshot.attempts[0];
    assert(original !== undefined);
    const closed = (id: string, startMinute: number, endMinute: number | null) =>
      new Attempt({
        ...original,
        id: AttemptId.make(id),
        startedAt: DateTime.add(now, { minutes: startMinute }),
        outcome: Option.some(
          new AttemptFailed({ failure: new InfraFailure({ message: "Lost", cause: "gone" }) }),
        ),
        endedAt:
          endMinute === null
            ? Option.none()
            : Option.some(DateTime.add(now, { minutes: endMinute })),
      });
    const running = new Attempt({
      ...original,
      id: AttemptId.make("open"),
      startedAt: DateTime.add(now, { minutes: 30 }),
    });
    const duration = runDuration(
      [closed("recorded", 0, 5), closed("legacy", 10, null), closed("silent", 20, null), running],
      new Map([[AttemptId.make("legacy"), DateTime.add(now, { minutes: 17 })]]),
    );
    assert.deepStrictEqual(
      { ...duration },
      { endedMillis: 12 * 60_000, runningSince: "2026-08-31T12:30:00.000Z", unmeasured: 1 },
    );
  });

  it.effect(
    "details the Run's Worker, how each Attempt's Worker is reached, Attempt time, why each Attempt began, and its tokens per session and pool, with a Claude Code child its Gateway paid with an API key among API keys",
    () =>
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
          start: Option.some(new StartedByEvent()),
        });
        const running = new Attempt({
          ...original,
          id: retryAttemptId,
          number: AttemptNumber.make(2),
          worker: WorkerName.make("usine-worker-1"),
          startedAt: DateTime.add(now, { minutes: 6 }),
          start: Option.some(new StartedByInfraRetry()),
          reattachedAt: Option.some(DateTime.add(now, { minutes: 9 })),
        });
        const current = new RunSnapshot({
          ...snapshot,
          run: new Run({ ...snapshot.run, state: new RunState.Running() }),
          attempts: [failed, running],
        });
        // `instance` declares only `local`; this one also declares `usine-worker-1` over SSH.
        const declared = new LoadedInstance({
          ...instance,
          config: Schema.decodeUnknownSync(UsineConfig)({
            version: 1,
            repos: [{ name: repository }],
            workers: [
              { name: "local", kind: "local" },
              {
                name: "usine-worker-1",
                kind: "ssh",
                destination: "usine-worker-1",
                root: "/home/usine/.usine",
              },
            ],
          }),
        });
        const usageQueries: Array<AttemptId> = [];
        const laterReports: Array<TranscriptEntry> = [];
        yield* Effect.gen(function* () {
          const detail = yield* (yield* Operator).detail(declared, runId);
          assert.strictEqual(detail.worker, "usine-worker-1");
          assert.deepStrictEqual(
            detail.run.attempts.map(({ workerAccess }) => workerAccess),
            [
              new LocalWorkerAccess(),
              new SshWorkerAccess({
                destination: SshDestination.make("usine-worker-1"),
                port: null,
              }),
            ],
          );
          assert.deepStrictEqual(
            { ...detail.duration },
            { endedMillis: 300_000, runningSince: "2026-08-31T12:06:00.000Z", unmeasured: 0 },
          );
          assert.deepStrictEqual(
            detail.run.attempts.map(({ start, reattachedAt }) => [start?._tag, reattachedAt]),
            [
              ["Event", null],
              ["InfraRetry", "2026-08-31T12:09:00.000Z"],
            ],
          );
          assert.strictEqual(detail.usage.tokens, 30_300);
          assert.deepStrictEqual(
            detail.usage.pools.map(
              ({ pool, tokens, cost }): readonly [string, number, object | null] => [
                pool,
                tokens,
                cost === null ? null : { ...cost },
              ],
            ),
            [
              ["apiKeys", 4_500, { usd: 1, estimate: false }],
              ["claudePlan", 20_000, { usd: 1.25, estimate: true }],
              ["chatgptPlan", 5_800, null],
            ],
          );
          // The Claude Code child on the local Worker used the Claude plan login; the one on the
          // SSH Worker used its Gateway's API key, priced at the model's rate.
          assert.deepStrictEqual(
            detail.usage.sessions.map(
              ({
                attemptId: attempt,
                session,
                pool,
                tokens,
                cost,
              }): readonly [string, string, string, number, object | null] => [
                attempt,
                session.id,
                pool,
                tokens,
                cost === null ? null : { ...cost },
              ],
            ),
            [
              [attemptId, "api-parent", "apiKeys", 1_500, { usd: 0.75, estimate: false }],
              [attemptId, "claude-child", "claudePlan", 20_000, { usd: 1.25, estimate: true }],
              [retryAttemptId, "plan-parent", "chatgptPlan", 800, null],
              [retryAttemptId, "codex-child", "chatgptPlan", 5_000, null],
              [
                retryAttemptId,
                "gateway-claude-child",
                "apiKeys",
                3_000,
                { usd: 0.25, estimate: false },
              ],
            ],
          );

          // The ended Attempt's reports are read once; the running one's on every read.
          const again = yield* (yield* Operator).detail(instance, runId);
          assert.strictEqual(again.usage.tokens, 30_300);
          assert.deepStrictEqual(
            again.run.attempts.map(({ workerAccess }) => workerAccess),
            [new LocalWorkerAccess(), null],
          );
          assert.deepStrictEqual(usageQueries, [attemptId, retryAttemptId, retryAttemptId]);

          // The Board card sums its Runs the same way, from the same cache.
          const overview = yield* (yield* Operator).overview(declared);
          const card = overview.projects[0]?.board.lanes
            .flatMap(({ items }) => items)
            .find(({ runs }) => runs.some(({ id }) => id === runId));
          assert(card !== undefined);
          assert.deepStrictEqual(
            {
              ...card.usage,
              pools: card.usage.pools.map(({ pool, tokens, cost, unpriced }) => [
                pool,
                tokens,
                cost?.usd ?? null,
                unpriced,
              ]),
              cost: card.usage.cost === null ? null : { ...card.usage.cost },
            },
            {
              durationMillis: 300_000,
              runningSince: ["2026-08-31T12:06:00.000Z"],
              unmeasured: 0,
              tokens: 30_300,
              pools: [
                ["apiKeys", 4_500, 1, false],
                ["claudePlan", 20_000, 1.25, false],
                ["chatgptPlan", 5_800, null, false],
              ],
              cost: { usd: 2.25, estimate: true },
            },
          );
          assert.deepStrictEqual(usageQueries, [
            attemptId,
            retryAttemptId,
            retryAttemptId,
            retryAttemptId,
          ]);

          // A later token report doesn't change the projection revision, so the next read keeps the
          // cached overview, rereads the running Attempt, and counts the new tokens.
          laterReports.push(tokenReport(retryAttemptId, codexChild, 9_000, null, 2_000));
          const later = yield* (yield* Operator).overview(declared);
          const laterCard = later.projects[0]?.board.lanes
            .flatMap(({ items }) => items)
            .find(({ runs }) => runs.some(({ id }) => id === runId));
          assert.strictEqual(laterCard?.usage.tokens, 34_300);
          assert.deepStrictEqual(
            laterCard?.usage.pools.map(({ pool, tokens }) => [pool, tokens]),
            [
              ["apiKeys", 4_500],
              ["claudePlan", 20_000],
              ["chatgptPlan", 9_800],
            ],
          );
          assert.strictEqual(yield* Ref.get(reads), 1);
          assert.deepStrictEqual(usageQueries.slice(4), [retryAttemptId]);
          // Without a new report, the read returns the same overview.
          assert.strictEqual(yield* (yield* Operator).overview(declared), later);
        }).pipe(
          Effect.provide(
            testLayer(
              approved,
              moved,
              reads,
              revision,
              current,
              undefined,
              undefined,
              usageQueries,
              laterReports,
            ),
          ),
        );
      }),
  );

  it.effect(
    "names on each Board card the Loops whose trigger matches its Items now, and renames them after a reload changes a trigger",
    () =>
      Effect.gen(function* () {
        const approved = yield* Ref.make<ReadonlyArray<RecordedApproval>>([]);
        const moved = yield* Ref.make<ItemLabelMutation | null>(null);
        const reads = yield* Ref.make(0);
        const revision = yield* Ref.make(Option.some(ProjectionRevision.make(1)));
        const issueLoop = (name: string, condition: string) =>
          new LoopFile({
            ...loop,
            name: LoopName.make(name),
            trigger: new IssueTrigger({ on: "issue", if: Source.make(condition) }),
          });
        const labelled = issueLoop(
          "start-dev",
          'item.labels.nodes.exists(label, label.name == "ready")',
        );
        const triage = issueLoop(
          "triage",
          'item.labels.nodes.exists(label, label.name == "triage")',
        );
        const pullRequests = new LoopFile({
          ...loop,
          name: LoopName.make("review-pr"),
          trigger: new PullRequestTrigger({ on: "pr", if: Source.make("true") }),
        });
        const watched = new LoadedInstance({
          ...instance,
          loops: [loop, labelled, triage, pullRequests],
        });
        const reloaded = new LoadedInstance({
          ...watched,
          loops: [
            loop,
            labelled,
            issueLoop("triage", 'item.labels.nodes.exists(label, label.name == "bug")'),
            pullRequests,
          ],
        });
        const cardLoops = (overview: ReadyOverview) =>
          overview.projects[0]?.board.lanes
            .flatMap((lane) => lane.items)
            .find((item) => item.itemKey === itemKey)?.loops;
        yield* Effect.gen(function* () {
          const operator = yield* Operator;
          // The paused Loop still watches the Item; a pull-request Loop never matches an issue.
          assert.deepStrictEqual(cardLoops(yield* operator.overview(watched)), [
            loopName,
            labelled.name,
          ]);
          assert.deepStrictEqual(cardLoops(yield* operator.overview(reloaded)), [
            loopName,
            labelled.name,
            triage.name,
          ]);
        }).pipe(Effect.provide(testLayer(approved, moved, reads, revision)));
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
        const retriedBy: Array<Option.Option<OperatorLogin>> = [];
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
          yield* operator.retry(configured, runId);
          assert.deepStrictEqual(retriedBy, [
            Option.some(OperatorLogin.make("Philippe")),
            Option.some(OperatorLogin.make("Philippe")),
          ]);
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
              retry: (_runId, request) =>
                Effect.sync(() => {
                  if (request === undefined) return;
                  retriedBy.push(request.requestedBy);
                  if (Option.isSome(request.amendment)) edits.push(request.amendment.value);
                }),
              intervene: (_runId, _attemptId, input) =>
                Effect.sync(() => {
                  inputs.push(input);
                }),
              runAgain: () => Effect.die("unused"),
            }),
          ),
        );
      }),
  );

  it.effect(
    "runs a Run again with its Loop file's gate, budget, and permissions, the selected roster Agent, and the configured operator",
    () =>
      Effect.gen(function* () {
        const approved = yield* Ref.make<ReadonlyArray<RecordedApproval>>([]);
        const moved = yield* Ref.make<ItemLabelMutation | null>(null);
        const reads = yield* Ref.make(0);
        const revision = yield* Ref.make(Option.some(ProjectionRevision.make(1)));
        const requests: Array<[RunId, RunAgainRequest]> = [];
        const reviewer = new AgentFile({
          ...agentFile,
          name: AgentName.make("reviewer"),
          parentModel: Option.some(ModelId.make("openai/new-parent")),
        });
        const configured = new LoadedInstance({
          ...instance,
          config: new UsineConfig({
            ...instance.config,
            operator: Option.some(OperatorLogin.make("Philippe")),
          }),
          agents: [agentFile, reviewer],
          loops: [new LoopFile({ ...loop, maxCycles: CycleLimit.make(5), permissions: "read" })],
        });
        const opened = new Claimed({
          eventId: EventId.make("run-again-event"),
          runId: RunId.make("run-opened-again"),
        });
        yield* Effect.gen(function* () {
          const operator = yield* Operator;
          const edit = new EditAndRetry({
            task: AttemptTask.make("Finish the review"),
            agent: reviewer.name,
          });
          assert.deepStrictEqual(yield* operator.runAgain(configured, runId, edit), opened);
          assert.deepStrictEqual(requests, [
            [
              runId,
              new RunAgainRequest({
                step: loop.step,
                approval: "required",
                cycleLimit: Option.some(CycleLimit.make(5)),
                permissions: "read",
                context: new AttemptContext({
                  task: AttemptTask.make("Finish the review"),
                  agent: reviewer.agent,
                  parentModel: reviewer.parentModel,
                }),
                requestedBy: Option.some(OperatorLogin.make("Philippe")),
              }),
            ],
          ]);
          const unknownAgent = yield* Effect.flip(
            operator.runAgain(
              configured,
              runId,
              new EditAndRetry({ task: edit.task, agent: AgentName.make("missing") }),
            ),
          );
          assert.strictEqual(unknownAgent._tag, "RosterAgentNotFoundError");
          const retired = yield* Effect.flip(
            operator.runAgain(new LoadedInstance({ ...configured, loops: [] }), runId, edit),
          );
          assert.strictEqual(retired._tag, "LoopNotFoundError");
          assert.strictEqual(requests.length, 1);
        }).pipe(
          Effect.provide(
            testLayer(approved, moved, reads, revision, snapshot, noCycleBudgets, {
              retry: () => Effect.die("unused"),
              intervene: () => Effect.die("unused"),
              runAgain: (id, request) =>
                Effect.sync(() => {
                  requests.push([id, request]);
                  return opened;
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
        close: () => Effect.die("unused"),
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
          // The overview and the detail both show who approved, when, and from where.
          const shown = new ApprovalView({
            approvedAt: DateTime.formatIso(now),
            source: askAnswer,
          });
          assert.deepStrictEqual(run.approval, shown);
          assert.deepStrictEqual((yield* operator.detail(instance, runId)).run.approval, shown);
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
        // The approval links the Item its Run works on, as the card shows it.
        const approval = overview.needsYou[0];
        assert(approval?._tag === "ApprovalNeed");
        assert.deepStrictEqual(
          approval.item,
          overview.projects[0]?.board.lanes[0]?.items[0]?.items[0],
        );

        const detail = yield* operator.detail(instance, runId, new ColdTranscriptRequest());
        assert.strictEqual(detail.eventDedupKey, snapshot.event.dedupKey);
        assert.deepStrictEqual(detail.eventPayload, { number: 31 });
        assert.strictEqual(detail.run.attempts[0]?.number, 1);
        assert.strictEqual(detail.transcript.length, 500);
        assert.strictEqual(detail.transcript[0]?.sequence, 3);
        assert.strictEqual(detail.transcript[0]?.payload._tag, "SessionEvent");
        assert.strictEqual(detail.earlierTranscript[0]?.attemptId, attemptId);
        assert.strictEqual(detail.earlierTranscript[0]?.before, 3);

        const tail = yield* operator.detail(
          instance,
          runId,
          new TailTranscriptRequest({ after: TranscriptSequence.make(1) }),
        );
        assert.strictEqual(tail.transcript.length, 500);
        assert.strictEqual(tail.transcript[0]?.sequence, 2);
        assert.strictEqual(tail.transcript.at(-1)?.sequence, 501);
        assert.deepStrictEqual(tail.earlierTranscript, []);
        const remainingTail = yield* operator.detail(
          instance,
          runId,
          new TailTranscriptRequest({ after: TranscriptSequence.make(501) }),
        );
        assert.deepStrictEqual(
          remainingTail.transcript.map(({ sequence }) => sequence),
          [502],
        );

        const earlier = yield* operator.detail(
          instance,
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
            instance,
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
        // The UI has no sign-in, so it approves as the operator set in `usine.yaml`.
        assert.deepStrictEqual(
          recorded.source,
          new ApprovalSource({
            channel: "ui",
            approver: Option.some(OperatorLogin.make("Philippe")),
          }),
        );
        // The approval Event is recorded whole: a deterministic identity for idempotent re-approval
        // and a typed payload.
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
      yield* Effect.gen(function* () {
        const operator = yield* Operator;
        const unconfiguredNeeds = (current: LoadedInstance) =>
          Effect.map(operator.overview(current), ({ needsYou }) =>
            needsYou.filter((need) => need._tag === "UnconfiguredWorkerNeed"),
          );
        // The reader reports three Attempts on `local`, the Worker `instance` declares, one of them open.
        assert.deepStrictEqual(yield* unconfiguredNeeds(instance), []);
        // A reload that changes only the Worker leaves the runtime store as it
        // was; the overview must not answer from its cache.
        const switched = new LoadedInstance({
          ...instance,
          config: new UsineConfig({
            ...instance.config,
            workers: [
              new LocalWorker({
                name: WorkerName.make("laptop"),
                kind: "local",
                maxConcurrentAttempts: 1,
              }),
            ],
          }),
        });
        // The reload removed `local` while it still runs one Attempt.
        const needs = yield* unconfiguredNeeds(switched);
        assert.deepStrictEqual(
          needs.map(({ id, worker, attempts, running }) => [id, worker, attempts, running]),
          [["unconfigured-worker:local", "local", 3, 1]],
        );
        const encoded = Schema.encodeUnknownSync(ReadyOverview)(
          new ReadyOverview({ projects: [], loops: [], needsYou: needs }),
        );
        assert.deepStrictEqual(Schema.decodeUnknownSync(ReadyOverview)(encoded).needsYou, needs);
      }).pipe(Effect.provide(testLayer(approved, moved, reads, revision)));
    }),
  );

  it.effect(
    "lists a closed Attempt whose parent task isn't confirmed stopped until a retried stop succeeds",
    () =>
      Effect.gen(function* () {
        const approved = yield* Ref.make<ReadonlyArray<RecordedApproval>>([]);
        const moved = yield* Ref.make<ItemLabelMutation | null>(null);
        const reads = yield* Ref.make(0);
        const revision = yield* Ref.make(Option.some(ProjectionRevision.make(1)));
        const local = WorkerName.make("local");
        const original = snapshot.attempts[0];
        assert(original !== undefined);
        const canceled = new RunSnapshot({
          ...snapshot,
          run: new Run({
            ...snapshot.run,
            state: RunState.cancelByOperator(new RunState.Running()),
          }),
          attempts: [new Attempt({ ...original, outcome: Option.some(new AttemptCanceled()) })],
        });
        const stops = yield* Ref.make([new UnconfirmedStop({ attemptId, runId, worker: local })]);
        yield* Effect.gen(function* () {
          const operator = yield* Operator;
          const unconfirmedNeeds = Effect.map(operator.overview(instance), ({ needsYou }) =>
            needsYou.filter((need) => need._tag === "UnconfirmedStopNeed"),
          );
          const needs = yield* unconfirmedNeeds;
          assert.deepStrictEqual(
            needs.map(({ id, repository, runId, loop, attemptNumber, worker }) => [
              id,
              repository,
              runId,
              loop,
              attemptNumber,
              worker,
            ]),
            [[`unconfirmed-stop:${attemptId}`, repository, runId, loopName, 1, local]],
          );
          const encoded = Schema.encodeUnknownSync(ReadyOverview)(
            new ReadyOverview({ projects: [], loops: [], needsYou: needs }),
          );
          assert.deepStrictEqual(Schema.decodeUnknownSync(ReadyOverview)(encoded).needsYou, needs);
          // The stop succeeds without a write to the runtime store; the overview must not answer
          // from its cache.
          yield* Ref.set(stops, []);
          assert.deepStrictEqual(yield* unconfirmedNeeds, []);
        }).pipe(
          Effect.provide(
            testLayer(
              approved,
              moved,
              reads,
              revision,
              canceled,
              noCycleBudgets,
              undefined,
              undefined,
              undefined,
              undefined,
              Ref.get(stops),
            ),
          ),
        );
      }),
  );

  it("lists a Worker whose every Attempt still runs, and refuses more open Attempts than Attempts", () => {
    const need = (running: number) =>
      new UnconfiguredWorkerNeed({
        id: "unconfigured-worker:local",
        worker: WorkerName.make("local"),
        attempts: 1,
        running,
      });
    // A removed Worker's only Attempt still runs: the entry reports it instead of failing the
    // overview.
    assert.doesNotThrow(() => need(1));
    assert.throws(() => need(2));
  });

  it("shows an Agent's blocker to the operator as its own failure kind", () => {
    const encoded = Schema.encodeUnknownSync(FailureView)(
      failureView(new BlockedFailure({ message: "The baseline gate fails on main." })),
    );
    assert.deepStrictEqual(encoded, {
      _tag: "BlockedFailure",
      message: "The baseline gate fails on main.",
    });
  });

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
