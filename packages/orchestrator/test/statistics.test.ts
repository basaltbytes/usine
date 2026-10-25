import { assert, describe, it } from "@effect/vitest";
import { Agent, AgentName, AgentPersona } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  type BillingPool,
  ParentSession,
  TokenCount,
  UsdAmount,
} from "@usine/core/agent/session";
import { Attempt, AttemptId, AttemptNumber, AttemptTask } from "@usine/core/attempt";
import { AgentFailure, InfraFailure } from "@usine/core/attempt/failure";
import {
  AttemptCanceled,
  AttemptFailed,
  type AttemptOutcome,
  AttemptSucceeded,
} from "@usine/core/attempt/outcome";
import {
  type AttemptStart,
  StartedByEvent,
  StartedByInfraRetry,
  StartedByRetry,
} from "@usine/core/attempt/start";
import { EventId } from "@usine/core/event";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { Run, RunId } from "@usine/core/run";
import { RunApproval } from "@usine/core/run/approval";
import * as RunState from "@usine/core/run/state";
import { Step, StepName } from "@usine/core/step";
import { WorkerName } from "@usine/core/worker";
import { RunSummary } from "@usine/engine/run-reader";
import { UsineConfig } from "@usine/config/factory";
import { LoadedInstance } from "@usine/config/instance";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { SessionTokensUpdated } from "@usine/core/agent/session";
import { ItemNumber } from "@usine/core/item";
import {
  ItemContentHash,
  ItemProjection,
  ItemProjectionReader,
  ItemProjectionSource,
} from "@usine/engine/item-projection";
import { RunReader } from "@usine/engine/run-reader";
import { TranscriptEntry, TranscriptSequence } from "@usine/engine/transcript";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { OperatorStatistics } from "../src/operator/statistics/statistics.ts";
import { gitHubItemKey } from "../src/polling/repository-sync.ts";
import {
  durationSummary,
  type PullRequestMerge,
  statisticsView,
} from "../src/operator/statistics/compute.ts";
import {
  RunUsageReader,
  RunUsageView,
  SessionUsageView,
  UsageCostView,
} from "../src/operator/usage.ts";

const at = (instant: string) => DateTime.makeUnsafe(`2026-10-${instant}:00.000Z`);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const repository = RepositoryName.make("basaltbytes/usine");
const opus = new BrainSpec({
  harness: "claude",
  model: ModelId.make("claude-opus"),
  effort: "high",
});
const gpt = new BrainSpec({ harness: "codex", model: ModelId.make("gpt-5"), effort: "high" });
const agentOf = (name: string, brain: BrainSpec) =>
  new Agent({
    name: AgentName.make(name),
    brain,
    parentModel: Option.none(),
    parentEffort: Option.none(),
    persona: AgentPersona.make("Work."),
  });
const developer = agentOf("developer", opus);
const reviewer = agentOf("reviewer", gpt);
const startDev = LoopName.make("start-dev");
const reviewPr = LoopName.make("review-pr");
const actOnFindings = LoopName.make("act-on-findings");

interface AttemptPlan {
  readonly worker: string;
  readonly startedAt: string;
  readonly outcome?: AttemptOutcome;
  readonly endedAt?: string;
  readonly start?: AttemptStart;
}

const attempts = (runId: string, agent: Agent, plans: ReadonlyArray<AttemptPlan>) =>
  plans.map(
    (plan, index) =>
      new Attempt({
        id: AttemptId.make(`${runId}/${index + 1}`),
        runId: RunId.make(runId),
        stepName: StepName.make("run"),
        worker: WorkerName.make(plan.worker),
        number: AttemptNumber.make(index + 1),
        brain: agent.brain,
        task: AttemptTask.make("Work on it."),
        agent: agent.name,
        operatorIntervened: false,
        parentModel: Option.none(),
        startedAt: at(plan.startedAt),
        outcome: Option.fromUndefinedOr(plan.outcome),
        endedAt: Option.map(Option.fromUndefinedOr(plan.endedAt), at),
        salvage: Option.none(),
        start: Option.some(
          plan.start ??
            (index === 0 ? new StartedByEvent() : new StartedByRetry({ operator: Option.none() })),
        ),
      }),
  );

interface RunPlan {
  readonly id: string;
  readonly item: number;
  readonly loop: LoopName;
  readonly agent: Agent;
  readonly state: RunState.RunState;
  readonly openedAt: string;
  readonly closedAt?: string;
  readonly approvedAt?: string;
  readonly attempts?: ReadonlyArray<AttemptPlan>;
}

const summary = (plan: RunPlan) =>
  new RunSummary({
    itemKey: gitHubItemKey(repository, plan.item),
    run: new Run({
      id: RunId.make(plan.id),
      eventId: EventId.make(`event-${plan.id}`),
      loop: plan.loop,
      state: plan.state,
      openedAt: at(plan.openedAt),
    }),
    step: new Step({
      runId: RunId.make(plan.id),
      name: StepName.make("run"),
      result: Option.none(),
    }),
    attempts: attempts(plan.id, plan.agent, plan.attempts ?? []),
    resolvedFailureAttemptId: Option.none(),
    closedAt: Option.map(Option.fromUndefinedOr(plan.closedAt), at),
    approval: Option.map(
      Option.fromUndefinedOr(plan.approvedAt),
      (approvedAt) => new RunApproval({ approvedAt: at(approvedAt), source: Option.none() }),
    ),
    runAgain: Option.none(),
    repository,
    task: AttemptTask.make("Work on it."),
    agent: plan.agent,
  });

const succeeded = new AttemptSucceeded();
const failed = (message: string) => new AttemptFailed({ failure: new AgentFailure({ message }) });
const operatorCanceled = new RunState.Canceled({ reason: new RunState.OperatorCanceled() });

const implemented = summary({
  id: "implemented",
  item: 1,
  loop: startDev,
  agent: developer,
  state: new RunState.Succeeded(),
  openedAt: "20T08:00",
  approvedAt: "20T08:10",
  closedAt: "20T09:15",
  attempts: [{ worker: "w1", startedAt: "20T08:15", outcome: succeeded, endedAt: "20T09:15" }],
});
const firstReview = summary({
  id: "first-review",
  item: 2,
  loop: reviewPr,
  agent: reviewer,
  state: new RunState.Succeeded(),
  openedAt: "21T10:00",
  closedAt: "21T10:20",
  attempts: [{ worker: "w1", startedAt: "21T10:01", outcome: succeeded, endedAt: "21T10:20" }],
});
// The first failure is retried automatically; the second waits an hour for the operator.
const fixed = summary({
  id: "fixed",
  item: 2,
  loop: actOnFindings,
  agent: developer,
  state: new RunState.Succeeded(),
  openedAt: "21T11:00",
  closedAt: "21T13:00",
  attempts: [
    {
      worker: "w2",
      startedAt: "21T11:01",
      outcome: new AttemptFailed({
        failure: new InfraFailure({ message: "Worker lost", cause: null }),
      }),
      endedAt: "21T11:05",
    },
    {
      worker: "w2",
      startedAt: "21T11:06",
      outcome: failed("Tests fail"),
      endedAt: "21T11:30",
      start: new StartedByInfraRetry(),
    },
    { worker: "w2", startedAt: "21T12:30", outcome: succeeded, endedAt: "21T13:00" },
  ],
});
const secondReview = summary({
  id: "second-review",
  item: 2,
  loop: reviewPr,
  agent: reviewer,
  state: new RunState.Succeeded(),
  openedAt: "21T13:05",
  closedAt: "21T13:16",
  attempts: [{ worker: "w1", startedAt: "21T13:06", outcome: succeeded, endedAt: "21T13:16" }],
});
const canceled = summary({
  id: "canceled",
  item: 3,
  loop: startDev,
  agent: developer,
  state: operatorCanceled,
  openedAt: "22T09:00",
  closedAt: "22T09:10",
  attempts: [
    { worker: "w1", startedAt: "22T09:01", outcome: new AttemptCanceled(), endedAt: "22T09:10" },
  ],
});
const superseded = summary({
  id: "superseded",
  item: 4,
  loop: reviewPr,
  agent: reviewer,
  state: new RunState.Canceled({
    reason: new RunState.Superseded({ by: EventId.make("event-newer") }),
  }),
  openedAt: "22T10:00",
  closedAt: "22T10:01",
});
const abandoned = summary({
  id: "abandoned",
  item: 7,
  loop: startDev,
  agent: developer,
  state: new RunState.Failed(),
  openedAt: "23T14:00",
  closedAt: "23T15:00",
  attempts: [
    { worker: "w2", startedAt: "23T14:02", outcome: failed("No login"), endedAt: "23T15:00" },
  ],
});
const running = summary({
  id: "running",
  item: 5,
  loop: startDev,
  agent: developer,
  state: new RunState.Running(),
  openedAt: "25T11:00",
  approvedAt: "25T11:30",
  attempts: [{ worker: "w1", startedAt: "25T11:31" }],
});
const waiting = summary({
  id: "waiting",
  item: 6,
  loop: startDev,
  agent: developer,
  state: new RunState.Waiting(),
  openedAt: "25T10:00",
});

const session = (
  attempt: string,
  pool: BillingPool,
  tokens: number,
  usd: number | null,
  brain: BrainSpec = opus,
) =>
  new SessionUsageView({
    attemptId: AttemptId.make(attempt),
    session: new ParentSession({
      id: AgentSessionId.make(`${attempt}/parent`),
      agent: AgentName.make("developer"),
      brain,
    }),
    pool,
    tokens: TokenCount.make(tokens),
    cost:
      usd === null
        ? null
        : new UsageCostView({ usd: UsdAmount.make(usd), estimate: pool === "claudePlan" }),
  });
const usageOf = (sessions: ReadonlyArray<SessionUsageView>) =>
  new RunUsageView({
    tokens: TokenCount.make(sessions.reduce((total, { tokens }) => total + tokens, 0)),
    pools: [],
    sessions,
  });
const usage = new Map([
  [implemented.run.id, usageOf([session("implemented/1", "claudePlan", 100_000, 2)])],
  [firstReview.run.id, usageOf([session("first-review/1", "chatgptPlan", 50_000, null, gpt)])],
  [
    fixed.run.id,
    usageOf([
      session("fixed/1", "apiKeys", 1_000, 0.1),
      session("fixed/2", "apiKeys", 20_000, null),
      session("fixed/3", "apiKeys", 30_000, 1.5),
    ]),
  ],
  [secondReview.run.id, usageOf([session("second-review/1", "chatgptPlan", 40_000, null, gpt)])],
  [abandoned.run.id, usageOf([session("abandoned/1", "apiKeys", 9_000, 1)])],
  // A ChatGPT plan parent with a priced Claude plan child.
  [
    RunId.make("only-review"),
    usageOf([
      session("only-review/1", "chatgptPlan", 10_000, null, gpt),
      session("only-review/1", "claudePlan", 2_000, 0.25),
    ]),
  ],
]);

const earlierImplementation = summary({
  id: "earlier-implementation",
  item: 8,
  loop: startDev,
  agent: developer,
  state: new RunState.Succeeded(),
  openedAt: "15T08:00",
  closedAt: "15T09:00",
  attempts: [{ worker: "w1", startedAt: "15T08:01", outcome: succeeded, endedAt: "15T09:00" }],
});
const onlyReview = summary({
  id: "only-review",
  item: 9,
  loop: reviewPr,
  agent: reviewer,
  state: new RunState.Succeeded(),
  openedAt: "23T08:00",
  closedAt: "23T08:30",
  attempts: [{ worker: "w1", startedAt: "23T08:01", outcome: succeeded, endedAt: "23T08:30" }],
});
const merges: ReadonlyArray<PullRequestMerge> = [
  // Two reviews on one pull request: a second round.
  { mergedAt: at("22T08:00"), runs: [implemented, firstReview, fixed, secondReview] },
  // The first Run on the Task opened before the window.
  { mergedAt: at("24T08:00"), runs: [earlierImplementation, onlyReview, superseded] },
  // Merged before the window.
  { mergedAt: at("10T08:00"), runs: [earlierImplementation] },
  // A pull request no Loop ran on, or only a superseded Run.
  { mergedAt: at("24T09:00"), runs: [] },
  { mergedAt: at("24T10:00"), runs: [superseded] },
];

const now = at("25T12:00");
const runs = [
  implemented,
  firstReview,
  fixed,
  secondReview,
  canceled,
  superseded,
  abandoned,
  onlyReview,
  running,
  waiting,
];
const workers = [
  { name: WorkerName.make("w1"), slots: 2 },
  { name: WorkerName.make("w2"), slots: 1 },
  { name: WorkerName.make("idle"), slots: 1 },
];
const week = statisticsView({ window: "7d", now, runs, usage, merges, workers });

describe("Statistics", () => {
  it("counts the closed Runs of the window by outcome and day, leaving out superseded Runs", () => {
    assert.strictEqual(week.from, "2026-10-19T00:00:00.000Z");
    assert.strictEqual(week.bucket, "day");
    assert.deepStrictEqual({ ...week.runs }, { succeeded: 5, failed: 1, canceled: 1 });
    assert.deepStrictEqual(
      week.throughput.map(({ start, succeeded, failed, canceled }) => [
        start,
        succeeded,
        failed,
        canceled,
      ]),
      [
        ["2026-10-19", 0, 0, 0],
        ["2026-10-20", 1, 0, 0],
        ["2026-10-21", 3, 0, 0],
        ["2026-10-22", 0, 0, 1],
        ["2026-10-23", 1, 1, 0],
        ["2026-10-24", 0, 0, 0],
        ["2026-10-25", 0, 0, 0],
      ],
    );
  });

  it("summarizes Run and Attempt time with the median and 90th percentile beside the mean", () => {
    // Run times: 75, 20, 120, 11, 10, 60, and 30 minutes.
    assert.deepStrictEqual(
      { ...week.runTime },
      {
        count: 7,
        meanMillis: Math.round((326 / 7) * MINUTE),
        medianMillis: 30 * MINUTE,
        p90Millis: Math.round(93 * MINUTE),
      },
    );
    assert.strictEqual(week.attemptTime?.count, 9);
    assert.strictEqual(week.unmeasuredAttempts, 0);
    assert.deepStrictEqual(
      { ...durationSummary([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) },
      {
        count: 10,
        meanMillis: 6,
        medianMillis: 6,
        p90Millis: 9,
      },
    );
    assert.isNull(durationSummary([]));
  });

  it("prices Runs whose dollar-rate sessions all have a price, and keeps tokens per pool", () => {
    assert.strictEqual(week.usage.tokens, 100_000 + 50_000 + 51_000 + 40_000 + 9_000 + 12_000);
    assert.strictEqual(week.usage.measured, 7);
    assert.deepStrictEqual(
      week.usage.pools.map(({ pool, tokens }) => [pool, tokens]),
      [
        ["apiKeys", 60_000],
        ["claudePlan", 102_000],
        ["chatgptPlan", 100_000],
      ],
    );
    // Priced: the Claude plan Run, the API key Run, and the ChatGPT plan Run whose Claude plan
    // child has a price. Not priced: the Run with an unpriced API key session, the ChatGPT plan
    // Runs, and the canceled Run with no session.
    const cost = week.usage.cost;
    assert.deepStrictEqual([cost?.usd, cost?.estimate, cost?.priced], [3.25, true, 3]);
    assert.closeTo(cost?.meanUsd ?? 0, 3.25 / 3, 1e-9);
  });

  it("breaks down Runs per Loop and Agent, and Attempts per harness, model, and effort", () => {
    assert.deepStrictEqual(
      week.loops.map(({ loop, outcomes }) => [loop, { ...outcomes }]),
      [
        ["review-pr", { succeeded: 3, failed: 0, canceled: 0 }],
        ["start-dev", { succeeded: 1, failed: 1, canceled: 1 }],
        ["act-on-findings", { succeeded: 1, failed: 0, canceled: 0 }],
      ],
    );
    const review = week.loops.find(({ loop }) => loop === reviewPr);
    assert.deepStrictEqual([review?.usage.cost?.usd, review?.usage.cost?.priced], [0.25, 1]);
    assert.strictEqual(review?.usage.meanTokens, 34_000);
    assert.deepStrictEqual(
      week.agents.map(({ agent, outcomes }) => [
        agent,
        outcomes.succeeded + outcomes.failed + outcomes.canceled,
      ]),
      [
        ["developer", 4],
        ["reviewer", 3],
      ],
    );
    assert.deepStrictEqual(
      week.brains.map(({ brain, outcomes, usage: { tokens } }) => [
        brain.harness,
        brain.model,
        { ...outcomes },
        tokens,
      ]),
      [
        ["claude", "claude-opus", { succeeded: 2, failed: 3, canceled: 1 }, 160_000],
        ["codex", "gpt-5", { succeeded: 3, failed: 0, canceled: 0 }, 102_000],
      ],
    );
    // Per Attempt, the API key Attempts with a price count as priced on their own.
    assert.strictEqual(week.brains[0]?.usage.cost?.priced, 4);
  });

  it("measures lead time to merge and first-pass merges from each Task's full Run history", () => {
    assert.deepStrictEqual({ ...week.firstPass }, { merged: 2, firstPass: 1 });
    assert.deepStrictEqual(
      { ...week.leadTime },
      {
        count: 2,
        meanMillis: 132 * HOUR,
        medianMillis: 132 * HOUR,
        p90Millis: Math.round((48 + 0.9 * 168) * HOUR),
      },
    );
  });

  it("measures queue wait from approval, Attempts per Run, and the share of slot time used", () => {
    assert.deepStrictEqual(
      week.queueWait.map(({ worker, wait }) => [worker, wait.count, wait.medianMillis]),
      [
        ["w1", 6, MINUTE],
        ["w2", 2, 1.5 * MINUTE],
      ],
    );
    assert.deepStrictEqual(
      week.attemptsPerRun.map(({ attempts, runs }) => [attempts, runs]),
      [
        [1, 6],
        [2, 0],
        [3, 1],
      ],
    );
    // w1's two slots held ended Attempts for 127 minutes and the running Attempt for 29.
    const windowMillis = (6 * 24 + 12) * HOUR;
    assert.deepStrictEqual(
      week.utilization.map(({ worker, slots, occupiedMillis, share }) => [
        worker,
        slots,
        occupiedMillis,
        share,
      ]),
      [
        ["w1", 2, 127 * MINUTE + 29 * MINUTE, (156 * MINUTE) / (2 * windowMillis)],
        [
          "w2",
          1,
          4 * MINUTE + 24 * MINUTE + 30 * MINUTE + 58 * MINUTE,
          (116 * MINUTE) / windowMillis,
        ],
        ["idle", 1, 0, 0],
      ],
    );
  });

  it("counts approvals asked and failures left to the operator, with their waits", () => {
    const attention = week.needsAttention;
    assert.strictEqual(attention.approvals, 3);
    assert.strictEqual(attention.failures, 2);
    assert.deepStrictEqual(
      attention.periods.flatMap(({ start, approvals, failures }) =>
        approvals + failures === 0 ? [] : [[start, approvals, failures]],
      ),
      [
        ["2026-10-20", 1, 0],
        ["2026-10-21", 0, 1],
        ["2026-10-23", 0, 1],
        ["2026-10-25", 2, 0],
      ],
    );
    assert.deepStrictEqual(
      [attention.approvalWait?.count, attention.approvalWait?.medianMillis],
      [2, 20 * MINUTE],
    );
    assert.deepStrictEqual(
      [attention.retryWait?.count, attention.retryWait?.medianMillis],
      [1, HOUR],
    );
  });

  it("starts the whole history at the first Run's day and splits a long one into weeks", () => {
    const old = summary({
      id: "old",
      item: 11,
      loop: startDev,
      agent: developer,
      state: new RunState.Succeeded(),
      openedAt: "25T08:00",
      closedAt: "25T09:00",
      attempts: [{ worker: "w1", startedAt: "25T08:01", outcome: succeeded, endedAt: "25T09:00" }],
    });
    const history = statisticsView({
      window: "all",
      now: DateTime.makeUnsafe("2027-01-20T12:00:00.000Z"),
      runs: [old],
      usage: new Map(),
      merges: [],
      workers,
    });
    assert.strictEqual(history.from, "2026-10-25T00:00:00.000Z");
    assert.strictEqual(history.bucket, "week");
    // 2026-10-19 is the Monday of the week of 2026-10-25.
    assert.strictEqual(history.throughput[0]?.start, "2026-10-19");
    assert.strictEqual(history.throughput[0]?.succeeded, 1);
    assert.strictEqual(history.throughput.at(-1)?.start, "2027-01-18");

    const empty = statisticsView({
      window: "all",
      now,
      runs: [],
      usage: new Map(),
      merges: [],
      workers: [],
    });
    assert.strictEqual(empty.from, "2026-10-25T00:00:00.000Z");
    assert.isNull(empty.runTime);
    assert.isNull(empty.usage.meanTokens);
    assert.deepStrictEqual(empty.attemptsPerRun, []);
  });
});

const issue = (number: number, pullRequests: ReadonlyArray<number>) =>
  new ItemProjection({
    itemKey: gitHubItemKey(repository, number),
    repository,
    source: ItemProjectionSource.make("issue"),
    number: ItemNumber.make(number),
    contentHash: ItemContentHash.make(`issue-${number}`),
    payload: {
      number,
      title: `Issue ${number}`,
      body: "",
      url: `https://github.com/basaltbytes/usine/issues/${number}`,
      state: "CLOSED",
      stateReason: null,
      createdAt: "2026-10-19T10:00:00Z",
      updatedAt: "2026-10-22T08:00:00Z",
      closedAt: "2026-10-22T08:00:00Z",
      author: { login: "PhilDL" },
      issueType: null,
      milestone: null,
      labels: { totalCount: 0, nodes: [] },
      assignees: { totalCount: 0, nodes: [] },
      comments: { totalCount: 0, nodes: [] },
      closedByPullRequestsReferences: {
        totalCount: pullRequests.length,
        nodes: pullRequests.map((pr) => ({
          number: pr,
          state: "MERGED",
          isDraft: false,
          url: `https://github.com/basaltbytes/usine/pull/${pr}`,
        })),
      },
    },
  });
const mergedPullRequest = (number: number, mergedAt: string) =>
  new ItemProjection({
    itemKey: gitHubItemKey(repository, number),
    repository,
    source: ItemProjectionSource.make("pr"),
    number: ItemNumber.make(number),
    contentHash: ItemContentHash.make(`pr-${number}`),
    payload: {
      number,
      title: `Pull request ${number}`,
      body: "",
      url: `https://github.com/basaltbytes/usine/pull/${number}`,
      state: "MERGED",
      isDraft: false,
      merged: true,
      createdAt: "2026-10-20T09:00:00Z",
      updatedAt: mergedAt,
      mergedAt,
      author: { login: "usine-bot" },
      baseRefName: "main",
      headRefName: `fix/${number}`,
      headRefOid: "410607d",
      additions: 1,
      deletions: 1,
      changedFiles: 1,
      reviewDecision: null,
      mergeable: "UNKNOWN",
      mergeStateStatus: "UNKNOWN",
      statusCheckRollup: null,
      labels: { totalCount: 0, nodes: [] },
      reviewRequests: { totalCount: 0, nodes: [] },
      reviews: { totalCount: 0, nodes: [] },
      reviewThreads: { totalCount: 0, nodes: [] },
      comments: { totalCount: 0, nodes: [] },
      closingIssuesReferences: { totalCount: 0, nodes: [] },
    },
  });

const tokenReport = (attempt: string, tokens: number, usd: number) =>
  new TranscriptEntry({
    sequence: TranscriptSequence.make(1),
    attemptId: AttemptId.make(attempt),
    direction: "outbound",
    envelope: new AttemptChannel.OutboundEnvelope({
      version: AttemptChannel.PROTOCOL_VERSION,
      attemptId: AttemptId.make(attempt),
      sequence: AttemptChannel.Sequence.make(1),
      sentAt: now,
      payload: new AttemptChannel.SessionEvent({
        event: new SessionTokensUpdated({
          session: new ParentSession({
            id: AgentSessionId.make(`${attempt}/parent`),
            agent: developer.name,
            brain: opus,
          }),
          totalTokens: TokenCount.make(tokens),
          costUsd: Option.some(UsdAmount.make(usd)),
        }),
      }),
    }),
    receivedAt: now,
  });

const instance = new LoadedInstance({
  config: Schema.decodeUnknownSync(UsineConfig)({
    version: 1,
    repos: [{ name: repository }],
    workers: [{ name: "w1", kind: "local", max_concurrent_attempts: 2 }],
  }),
  agents: [],
  invalidAgents: [],
  loops: [],
  quarantinedLoops: [],
  warnings: [],
});

describe("OperatorStatistics", () => {
  it.effect(
    "reads the window's closed Runs once, the open Runs, usage, and merges linked through issues",
    () =>
      Effect.gen(function* () {
        const since: Array<Option.Option<DateTime.Utc>> = [];
        const closedRuns = [implemented, firstReview, onlyReview];
        const reader = Layer.succeed(RunReader)({
          inspect: () => Effect.die("unused"),
          evidence: () => Effect.die("unused"),
          // The open Runs, and a closed Run that the window read already counts.
          list: () => Effect.succeed([running, waiting, implemented]),
          closed: () => Effect.die("unused"),
          closedSince: (from) => Effect.sync(() => since.push(from)).pipe(Effect.as(closedRuns)),
          forItems: (keys) =>
            Effect.succeed(
              [implemented, firstReview, onlyReview].filter(({ itemKey }) =>
                keys.includes(itemKey),
              ),
            ),
          events: () => Effect.die("unused"),
          revision: () => Effect.die("unused"),
          transcript: (query) =>
            Effect.succeed(
              query._tag === "TranscriptUsageQuery" && query.attemptId === "implemented/1"
                ? [tokenReport("implemented/1", 100_000, 2)]
                : [],
            ),
          attemptsByWorker: () => Effect.die("unused"),
          sightings: () => Effect.die("unused"),
        });
        const items = Layer.succeed(ItemProjectionReader)({
          get: () => Effect.die("unused"),
          openIssues: () => Effect.die("unused"),
          list: () =>
            Effect.succeed([
              issue(1, [2]),
              mergedPullRequest(2, "2026-10-22T08:00:00Z"),
              // Merged before the window.
              mergedPullRequest(9, "2026-10-10T08:00:00Z"),
              new ItemProjection({
                itemKey: gitHubItemKey(repository, 12),
                repository,
                source: ItemProjectionSource.make("pr"),
                number: ItemNumber.make(12),
                contentHash: ItemContentHash.make("malformed-12"),
                payload: { number: 12 },
              }),
            ]),
        });
        yield* TestClock.setTime(DateTime.toEpochMillis(now));
        const statistics = yield* OperatorStatistics.use(({ statistics }) =>
          statistics(instance, "7d"),
        ).pipe(
          Effect.provide(
            OperatorStatistics.layer.pipe(
              Layer.provide(RunUsageReader.layer),
              Layer.provide(Layer.merge(reader, items)),
            ),
          ),
        );

        assert.deepStrictEqual(since, [Option.some(at("19T00:00"))]);
        assert.deepStrictEqual({ ...statistics.runs }, { succeeded: 3, failed: 0, canceled: 0 });
        assert.strictEqual(statistics.usage.tokens, 100_000);
        assert.deepStrictEqual({ ...statistics.firstPass }, { merged: 1, firstPass: 1 });
        assert.strictEqual(statistics.leadTime?.medianMillis, 48 * HOUR);
        assert.strictEqual(statistics.needsAttention.approvals, 3);
        assert.deepStrictEqual(
          statistics.utilization.map(({ worker, slots }) => [worker, slots]),
          [["w1", 2]],
        );
      }),
  );
});
