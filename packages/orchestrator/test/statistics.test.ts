import { AttemptSummary } from "@usine/engine/run-reader";
import { issue, mergedPullRequest } from "./statistics/fixtures.ts";
import { MachineStarts } from "@usine/executor";
import { WorkerStatus } from "../src/worker-status.ts";
import { configurationLayer } from "./support/configuration.ts";
import { assert, describe, it } from "@effect/vitest";
import { Agent, AgentName, AgentPersona } from "@usine/core/agent";
import { Harness, BrainSpec, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  type BillingPool,
  ParentSession,
  TokenCount,
  UsdAmount,
} from "@usine/core/agent/session";
import {
  Attempt,
  AttemptId,
  AttemptNumber,
  AttemptTask,
  FailureResolution,
  OutOfMemoryKills,
} from "@usine/core/attempt";
import { AgentFailure, InfraFailure } from "@usine/core/attempt/failure";
import {
  AttemptCanceled,
  AttemptHandedOff,
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
import { CommitSha, RepositoryName } from "@usine/core/repository";
import { Run, RunId } from "@usine/core/run";
import { RunApproval } from "@usine/core/run/approval";
import * as RunState from "@usine/core/run/state";
import { StepName } from "@usine/core/step";
import { ContainerMemoryMib, WorkerName } from "@usine/core/worker";
import { ProjectionRevision, RunSummary } from "@usine/engine/run-reader";
import { UsineConfig } from "@usine/config/factory";
import { LoadedInstance } from "@usine/config/instance";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { SessionTokensUpdated } from "@usine/core/agent/session";
import { ItemNumber } from "@usine/core/item";
import {
  ItemContentHash,
  ItemProjection,
  ItemProjectionSource,
  ItemProjectionReader,
} from "@usine/engine/item-projection";
import { RunReader } from "@usine/engine/run-reader";
import { TranscriptEntry, TranscriptSequence } from "@usine/engine/transcript";
import { CycleGeneration } from "@usine/core/cycle-budget";
import { CycleBudgets } from "@usine/engine/cycle-budget";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { OperatorStatistics } from "../src/operator/statistics/statistics.ts";
import { gitHubItemKey } from "../src/polling/repository-sync.ts";
import { durationSummary, runStatisticsView } from "../src/operator/statistics/runs.ts";
import { type MergedTask, taskStatisticsView } from "../src/operator/statistics/tasks.ts";
import { emptyCycleBudgets } from "./support/polling.ts";
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
const opus = BrainSpec.make({
  harness: Harness.make("claude"),
  model: ModelId.make("claude-opus"),
  effort: "high",
});
const gpt = BrainSpec.make({
  harness: Harness.make("codex"),
  model: ModelId.make("gpt-5"),
  effort: "high",
});
const agentOf = (name: string, brain: BrainSpec) =>
  Agent.make({
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
  readonly memoryKills?: number;
  /** The agent selected for the attempt, if not the run's. */
  readonly agent?: Agent;
}

const attempts = (runId: string, agent: Agent, plans: ReadonlyArray<AttemptPlan>) =>
  plans.map((plan, index) =>
    Attempt.make({
      id: AttemptId.make(`${runId}/${index + 1}`),
      runId: RunId.make(runId),
      stepName: StepName.make("run"),
      worker: WorkerName.make(plan.worker),
      number: AttemptNumber.make(index + 1),
      brain: (plan.agent ?? agent).brain,
      task: AttemptTask.make("Work on it."),
      agent: (plan.agent ?? agent).name,
      operatorIntervened: false,
      outOfMemory:
        plan.memoryKills === undefined
          ? Option.none()
          : Option.some(
              OutOfMemoryKills.make({
                kills: plan.memoryKills,
                memoryMib: ContainerMemoryMib.make(6656),
              }),
            ),
      parentModel: Option.none(),
      startedAt: at(plan.startedAt),
      outcome: Option.fromUndefinedOr(plan.outcome),
      endedAt: Option.map(Option.fromUndefinedOr(plan.endedAt), at),
      salvage: Option.none(),
      start: Option.some(
        plan.start ??
          (index === 0 ? StartedByEvent.make() : StartedByRetry.make({ operator: Option.none() })),
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
  RunSummary.make({
    itemKey: gitHubItemKey(repository, plan.item),
    run: Run.make({
      id: RunId.make(plan.id),
      eventId: EventId.make(`event-${plan.id}`),
      loop: plan.loop,
      state: plan.state,
      openedAt: at(plan.openedAt),
    }),
    pullRequestUrl: null,
    attempts: attempts(plan.id, plan.agent, plan.attempts ?? []).map((attempt) =>
      AttemptSummary.make(attempt),
    ),
    resolvedFailureAttemptId: Option.none(),
    closedAt: Option.map(Option.fromUndefinedOr(plan.closedAt), at),
    approval: Option.map(Option.fromUndefinedOr(plan.approvedAt), (approvedAt) =>
      RunApproval.make({ approvedAt: at(approvedAt), source: Option.none() }),
    ),
    runAgain: Option.none(),
    repository,
    agent: plan.agent,
  });

const succeeded = AttemptSucceeded.make();
const failed = (message: string) => AttemptFailed.make({ failure: AgentFailure.make({ message }) });
const operatorCanceled = RunState.Canceled.make({ reason: RunState.OperatorCanceled.make() });

const implemented = summary({
  id: "implemented",
  item: 1,
  loop: startDev,
  agent: developer,
  state: RunState.Succeeded.make(),
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
  state: RunState.Succeeded.make(),
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
  state: RunState.Succeeded.make(),
  openedAt: "21T11:00",
  closedAt: "21T13:00",
  attempts: [
    {
      worker: "w2",
      startedAt: "21T11:01",
      outcome: AttemptFailed.make({
        failure: InfraFailure.make({ message: "Worker lost", cause: null }),
      }),
      endedAt: "21T11:05",
    },
    {
      worker: "w2",
      startedAt: "21T11:06",
      outcome: failed("Tests fail"),
      endedAt: "21T11:30",
      start: StartedByInfraRetry.make(),
    },
    { worker: "w2", startedAt: "21T12:30", outcome: succeeded, endedAt: "21T13:00" },
  ],
});
const secondReview = summary({
  id: "second-review",
  item: 2,
  loop: reviewPr,
  agent: reviewer,
  state: RunState.Succeeded.make(),
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
    { worker: "w1", startedAt: "22T09:01", outcome: AttemptCanceled.make(), endedAt: "22T09:10" },
  ],
});
const superseded = summary({
  id: "superseded",
  item: 4,
  loop: reviewPr,
  agent: reviewer,
  state: RunState.Canceled.make({
    reason: RunState.Superseded.make({ by: EventId.make("event-newer") }),
  }),
  openedAt: "22T10:00",
  closedAt: "22T10:01",
});
const abandoned = summary({
  id: "abandoned",
  item: 7,
  loop: startDev,
  agent: developer,
  state: RunState.Failed.make(),
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
  state: RunState.Running.make(),
  openedAt: "25T11:00",
  approvedAt: "25T11:30",
  attempts: [{ worker: "w1", startedAt: "25T11:31" }],
});
const waiting = summary({
  id: "waiting",
  item: 6,
  loop: startDev,
  agent: developer,
  state: RunState.Waiting.make(),
  openedAt: "25T10:00",
});

const session = (
  attempt: string,
  pool: BillingPool,
  tokens: number,
  usd: number | null,
  brain: BrainSpec = opus,
) =>
  SessionUsageView.make({
    attemptId: AttemptId.make(attempt),
    session: ParentSession.make({
      id: AgentSessionId.make(`${attempt}/parent`),
      agent: AgentName.make("developer"),
      brain,
    }),
    pool,
    tokens: TokenCount.make(tokens),
    cost:
      usd === null
        ? null
        : UsageCostView.make({ usd: UsdAmount.make(usd), estimate: pool !== "apiKeys" }),
  });
const usageOf = (sessions: ReadonlyArray<SessionUsageView>) =>
  RunUsageView.make({
    tokens: TokenCount.make(sessions.reduce((total, { tokens }) => total + tokens, 0)),
    pools: [],
    sessions,
  });
const usage = new Map([
  [implemented.run.id, usageOf([session("implemented/1", "claudePlan", 100_000, 2)])],
  [firstReview.run.id, usageOf([session("first-review/1", "chatgptPlan", 50_000, 0.5, gpt)])],
  [
    fixed.run.id,
    usageOf([
      session("fixed/1", "apiKeys", 1_000, 0.1),
      session("fixed/2", "apiKeys", 20_000, null),
      session("fixed/3", "apiKeys", 30_000, 1.5),
    ]),
  ],
  // Recorded before Codex sessions reported a token breakdown, so it has no price.
  [secondReview.run.id, usageOf([session("second-review/1", "chatgptPlan", 40_000, null, gpt)])],
  [abandoned.run.id, usageOf([session("abandoned/1", "apiKeys", 9_000, 1)])],
  // A ChatGPT plan parent with a Claude plan child.
  [
    RunId.make("only-review"),
    usageOf([
      session("only-review/1", "chatgptPlan", 10_000, 0.25, gpt),
      session("only-review/1", "claudePlan", 2_000, 0.25),
    ]),
  ],
  [RunId.make("unrecorded-end"), usageOf([session("unrecorded-end/1", "claudePlan", 80_000, 4)])],
]);

const earlierImplementation = summary({
  id: "earlier-implementation",
  item: 8,
  loop: startDev,
  agent: developer,
  state: RunState.Succeeded.make(),
  openedAt: "15T08:00",
  closedAt: "15T09:00",
  attempts: [{ worker: "w1", startedAt: "15T08:01", outcome: succeeded, endedAt: "15T09:00" }],
});
const onlyReview = summary({
  id: "only-review",
  item: 9,
  loop: reviewPr,
  agent: reviewer,
  state: RunState.Succeeded.make(),
  openedAt: "23T08:00",
  closedAt: "23T08:30",
  attempts: [{ worker: "w1", startedAt: "23T08:01", outcome: succeeded, endedAt: "23T08:30" }],
});
// Its Attempt ended before usine recorded end times.
const unrecordedEnd = summary({
  id: "unrecorded-end",
  item: 12,
  loop: startDev,
  agent: developer,
  state: RunState.Succeeded.make(),
  openedAt: "19T09:00",
  closedAt: "19T10:00",
  attempts: [{ worker: "w1", startedAt: "19T09:01", outcome: succeeded }],
});

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
  {
    name: WorkerName.make("w1"),
    slots: 2,
    initialSlots: 1,
    changes: [{ at: at("22T00:00"), slots: 2 }],
  },
  { name: WorkerName.make("w2"), slots: 1, initialSlots: 1, changes: [] },
  { name: WorkerName.make("idle"), slots: 1, initialSlots: 1, changes: [] },
];
const week = runStatisticsView({ window: "7d", now, runs, usage, workers });

const mergedTask = (
  number: number,
  mergedAt: DateTime.Utc,
  taskRuns: ReadonlyArray<RunSummary>,
  budgetResets = 0,
): MergedTask => ({
  repository,
  number: ItemNumber.make(number),
  mergedAt,
  runs: taskRuns,
  budgetResets,
});
const tasks = [
  // A review round, an approval, an operator retry, and a cycle-budget reset.
  mergedTask(1, at("22T08:00"), [implemented, firstReview, fixed, secondReview], 1),
  // The first Run opened before the window, and the superseded Run is left out.
  mergedTask(8, at("24T08:00"), [earlierImplementation, onlyReview, superseded]),
  mergedTask(12, at("23T12:00"), [unrecordedEnd]),
  // Merged before the window.
  mergedTask(9, at("10T08:00"), [earlierImplementation]),
  // Only a superseded Run.
  mergedTask(4, at("24T10:00"), [superseded]),
];
const done = taskStatisticsView({ window: "7d", now, tasks, usage });

describe("Task statistics", () => {
  it("counts repeated memory kills once per attempt, including successful attempts, within the task window", () => {
    const withKills = (id: string, kills: number) =>
      summary({
        id,
        item: 1,
        loop: startDev,
        agent: developer,
        state: RunState.Succeeded.make(),
        openedAt: "21T08:00",
        closedAt: "21T09:00",
        attempts: [
          {
            worker: "w1",
            startedAt: "21T08:01",
            outcome: succeeded,
            endedAt: "21T09:00",
            memoryKills: kills,
          },
        ],
      });
    const view = taskStatisticsView({
      window: "7d",
      now,
      usage: new Map(),
      tasks: [
        mergedTask(1, at("22T08:00"), [withKills("one", 2), withKills("two", 1)]),
        mergedTask(2, at("10T08:00"), [withKills("excluded", 9)]),
      ],
    });
    assert.strictEqual(view.memoryKills, 3);
    assert.strictEqual(view.memoryKillAttempts, 2);
    assert.strictEqual(view.repeatedMemoryKillAttempts, 1);
    assert.strictEqual(done.memoryKills, 0);
  });

  it("counts the tasks merged in the window, from the first Run's opening to the last Run's close", () => {
    assert.strictEqual(done.from, "2026-10-19T00:00:00.000Z");
    assert.deepStrictEqual(
      done.tasks.map(({ number, mergedAt, durationMillis }) => [number, mergedAt, durationMillis]),
      [
        // The wait from the last Run's close to the merge is left out.
        [1, "2026-10-22T08:00:00.000Z", 1756 * MINUTE],
        [12, "2026-10-23T12:00:00.000Z", 1 * HOUR],
        [8, "2026-10-24T08:00:00.000Z", 192.5 * HOUR],
      ],
    );
    assert.strictEqual(done.medianMillis, 1756 * MINUTE);
    assert.deepStrictEqual(
      done.periods.flatMap(({ start, tasks, medianMillis, firstTimeRight, operatorActions }) =>
        tasks === 0 ? [] : [[start, tasks, medianMillis, firstTimeRight, operatorActions]],
      ),
      [
        ["2026-10-22", 1, 1756 * MINUTE, 0, 3],
        ["2026-10-23", 1, 1 * HOUR, 1, 0],
        ["2026-10-24", 1, 192.5 * HOUR, 1, 0],
      ],
    );
  });

  it("counts a second successful Run of a Loop as a round, and the operator's actions", () => {
    assert.strictEqual(done.firstTimeRight, 2);
    // The approval, the retry after the agent failure, and the reset.
    assert.strictEqual(done.operatorActions, 3);
  });

  it("splits task time between the Loops' Attempts and the waits, in the Loops' order", () => {
    // 1,756 minutes from the first Run to the last close, and 11,550 for the task that opened earlier.
    const first = (minutes: number) => (minutes * MINUTE) / (1756 * MINUTE);
    const second = (minutes: number) => (minutes * MINUTE) / (192.5 * HOUR);
    assert.strictEqual(done.time?.tasks, 2);
    // Ranked 0, 0.5, and 1 in the first task, and 0 and 1 in the second.
    assert.deepStrictEqual(done.loops, [startDev, reviewPr, actOnFindings]);
    assert.deepStrictEqual(
      done.time?.loops.map(({ loop }) => loop),
      [startDev, reviewPr, actOnFindings],
    );
    const shares = new Map(done.time?.loops.map(({ loop, share }) => [loop, share]));
    assert.closeTo(shares.get(startDev) ?? 0, (first(60) + second(59)) / 2, 1e-9);
    assert.closeTo(shares.get(reviewPr) ?? 0, (first(29) + second(29)) / 2, 1e-9);
    assert.closeTo(shares.get(actOnFindings) ?? 0, first(58) / 2, 1e-9);
    assert.closeTo(done.time?.waiting ?? 0, (first(1609) + second(11462)) / 2, 1e-9);
    assert.deepStrictEqual(
      done.time?.runs.map(({ loop, runs, medianMillis }) => [loop, runs, medianMillis]),
      [
        [startDev, 2, 59.5 * MINUTE],
        [reviewPr, 3, 19 * MINUTE],
        [actOnFindings, 1, 58 * MINUTE],
      ],
    );
    assert.deepStrictEqual({ ...done.untimed }, { tasks: 1, before: "2026-10-20" });
  });

  it("measures tokens per task, and prices only the tasks whose sessions all have a price", () => {
    assert.strictEqual(done.unmetered, 1);
    assert.strictEqual(done.tokens?.tasks, 2);
    assert.strictEqual(done.tokens?.medianTokens, (241_000 + 80_000) / 2);
    const shares = new Map(done.tokens?.loops.map(({ loop, share }) => [loop, share]));
    assert.closeTo(shares.get(startDev) ?? 0, (100 / 241 + 1) / 2, 1e-9);
    assert.closeTo(shares.get(reviewPr) ?? 0, 90 / 241 / 2, 1e-9);
    assert.closeTo(shares.get(actOnFindings) ?? 0, 51 / 241 / 2, 1e-9);
    // Task 1 has unpriced sessions; task 12 is priced.
    assert.deepStrictEqual({ ...done.tokens?.cost }, { tasks: 1, medianUsd: 4, estimate: true });
  });

  it("shares overlapping Attempts, prices fully priced tasks, and splits a long history into weeks", () => {
    const develop = summary({
      id: "develop",
      item: 20,
      loop: startDev,
      agent: developer,
      state: RunState.Succeeded.make(),
      openedAt: "25T08:00",
      closedAt: "25T10:00",
      attempts: [{ worker: "w1", startedAt: "25T08:00", outcome: succeeded, endedAt: "25T10:00" }],
    });
    const review = summary({
      id: "review",
      item: 21,
      loop: reviewPr,
      agent: reviewer,
      state: RunState.Succeeded.make(),
      openedAt: "25T09:00",
      closedAt: "25T11:00",
      attempts: [{ worker: "w1", startedAt: "25T09:00", outcome: succeeded, endedAt: "25T11:00" }],
    });
    const history = taskStatisticsView({
      window: "all",
      now: DateTime.makeUnsafe("2027-01-20T12:00:00.000Z"),
      tasks: [mergedTask(20, at("25T20:00"), [develop, review])],
      usage: new Map([
        [develop.run.id, usageOf([session("develop/1", "claudePlan", 10_000, 1)])],
        [review.run.id, usageOf([session("review/1", "apiKeys", 5_000, 0.5)])],
      ]),
    });
    assert.strictEqual(history.from, "2026-10-25T00:00:00.000Z");
    assert.strictEqual(history.bucket, "week");
    // 2026-10-19 is the Monday of the week of 2026-10-25.
    assert.deepStrictEqual(
      [history.periods[0]?.start, history.periods[0]?.tasks, history.periods.at(-1)?.start],
      ["2026-10-19", 1, "2027-01-18"],
    );
    // Each Loop ran 60 minutes alone and shared 60 more, out of the 180 before the last close.
    assert.deepStrictEqual(
      history.time?.loops.map(({ loop, share }) => [loop, share]),
      [
        [startDev, 90 / 180],
        [reviewPr, 90 / 180],
      ],
    );
    assert.strictEqual(history.time?.waiting, 0);
    assert.deepStrictEqual(
      { ...history.tokens?.cost },
      { tasks: 1, medianUsd: 1.5, estimate: true },
    );

    const empty = taskStatisticsView({ window: "all", now, tasks: [], usage });
    assert.strictEqual(empty.from, "2026-10-25T00:00:00.000Z");
    assert.deepStrictEqual(
      [empty.medianMillis, empty.time, empty.tokens, empty.untimed],
      [null, null, null, null],
    );
  });
});

describe("Model statistics", () => {
  const ran = (
    id: string,
    item: number,
    loop: LoopName,
    agent: Agent,
    day: string,
    hour: number,
  ): RunSummary => {
    const start = `${day}T${String(hour).padStart(2, "0")}`;
    const end = `${day}T${String(hour + 1).padStart(2, "0")}`;
    return summary({
      id,
      item,
      loop,
      agent,
      state: RunState.Succeeded.make(),
      openedAt: `${start}:00`,
      closedAt: `${end}:00`,
      attempts: [
        { worker: "w1", startedAt: `${start}:00`, outcome: succeeded, endedAt: `${end}:00` },
      ],
    });
  };
  const developerOnGpt = agentOf("developer", gpt);
  const firstTry = ran("first-try", 30, startDev, developer, "21", 8);
  const view = taskStatisticsView({
    window: "7d",
    now,
    usage: new Map([
      [firstTry.run.id, usageOf([session("first-try/1", "claudePlan", 10_000, 1)])],
      [
        RunId.make("first-try-review"),
        usageOf([session("first-try-review/1", "apiKeys", 5_000, 0.5, gpt)]),
      ],
    ]),
    tasks: [
      mergedTask(30, at("21T12:00"), [
        firstTry,
        ran("first-try-review", 31, reviewPr, reviewer, "21", 9),
      ]),
      // A second review round, after a fix that the developer ran on another model.
      mergedTask(32, at("22T18:00"), [
        ran("two-rounds", 32, startDev, developer, "22", 8),
        ran("two-rounds-review", 33, reviewPr, reviewer, "22", 9),
        ran("two-rounds-fix", 33, actOnFindings, developerOnGpt, "22", 10),
        ran("two-rounds-second-review", 33, reviewPr, reviewer, "22", 11),
      ]),
      mergedTask(34, at("23T10:00"), [
        ran("on-gpt", 34, startDev, developerOnGpt, "23", 8),
        ran("on-gpt-review", 35, reviewPr, reviewer, "23", 9),
      ]),
      // Merged before the window.
      mergedTask(36, at("10T10:00"), [ran("early", 36, startDev, developerOnGpt, "10", 8)]),
    ],
  });

  it("attributes each task to the model of the agent's first attempt on it, and marks it mixed", () => {
    assert.deepStrictEqual(
      view.agents.map(({ agent, tasks, opened, models }) => [
        agent,
        tasks,
        opened,
        models.map(({ harness, model, tasks, mixed }) => [harness, model, tasks, mixed]),
      ]),
      [
        [
          "developer",
          3,
          3,
          [
            ["claude", "claude-opus", 2, 1],
            ["codex", "gpt-5", 1, 0],
          ],
        ],
        ["reviewer", 3, 0, [["codex", "gpt-5", 3, 0]]],
      ],
    );
  });

  it("measures review rounds, time to merge, and usage per merged task, all loops summed", () => {
    const [opusTasks, gptTasks] = view.agents[0]?.models ?? [];
    assert.deepStrictEqual(
      [opusTasks, gptTasks].map((outcome) => [
        outcome?.firstTimeRight,
        outcome?.medianRounds,
        outcome?.medianMillis,
        outcome?.metered,
        outcome?.medianTokens,
        outcome?.cost === null ? null : { ...outcome?.cost },
      ]),
      [
        // From the first attempt to the merge: 4 hours and 10 hours.
        [1, 1.5, 7 * HOUR, 1, 15_000, { tasks: 1, medianUsd: UsdAmount.make(1.5), estimate: true }],
        [1, 1, 2 * HOUR, 0, null, null],
      ],
    );
    // From each task's first attempt, by any agent, not from the reviewer's: 4, 10, and 2 hours.
    assert.deepStrictEqual(
      view.agents[1]?.models.map(({ model, medianMillis }) => [model, medianMillis]),
      [["gpt-5", 4 * HOUR]],
    );
  });

  it("counts only successful runs as review rounds", () => {
    const unsuccessful = (id: string, state: RunState.RunState, outcome: AttemptOutcome) =>
      summary({
        id,
        item: 31,
        loop: reviewPr,
        agent: reviewer,
        state,
        openedAt: "21T09:00",
        closedAt: "21T09:30",
        attempts: [{ worker: "w1", startedAt: "21T09:00", outcome, endedAt: "21T09:30" }],
      });
    const withUnsuccessful = taskStatisticsView({
      window: "7d",
      now,
      usage: new Map(),
      tasks: [
        // A failed review and a canceled one before the review that succeeds.
        mergedTask(30, at("21T12:00"), [
          firstTry,
          unsuccessful("failed-review", RunState.Failed.make(), failed("No login")),
          unsuccessful("canceled-review", operatorCanceled, AttemptCanceled.make()),
          ran("first-try-review", 31, reviewPr, reviewer, "21", 9),
        ]),
      ],
    });
    const rounds = (statistics: typeof view) => [
      statistics.firstTimeRight,
      statistics.agents.map(({ agent, models }) => [
        agent,
        models.map(({ model, firstTimeRight, medianRounds }) => [
          model,
          firstTimeRight,
          medianRounds,
        ]),
      ]),
    ];
    assert.deepStrictEqual(rounds(withUnsuccessful), [
      1,
      [
        ["developer", [["claude-opus", 1, 1]]],
        ["reviewer", [["gpt-5", 1, 1]]],
      ],
    ]);
  });

  it("orders attempts by their start, not by run, and does not split tasks by reasoning effort", () => {
    const developerOnLowEffort = agentOf("developer", BrainSpec.make({ ...opus, effort: "low" }));
    const ordered = taskStatisticsView({
      window: "7d",
      now,
      usage: new Map(),
      tasks: [
        // The first run opened first, but its attempt started after the second run's attempt.
        mergedTask(40, at("24T14:00"), [
          summary({
            id: "queued-first",
            item: 40,
            loop: startDev,
            agent: developer,
            state: RunState.Succeeded.make(),
            openedAt: "24T08:00",
            closedAt: "24T12:00",
            attempts: [
              { worker: "w1", startedAt: "24T11:00", outcome: succeeded, endedAt: "24T12:00" },
            ],
          }),
          ran("started-first", 41, actOnFindings, developerOnGpt, "24", 9),
        ]),
        // The same model at another reasoning effort.
        mergedTask(42, at("23T20:00"), [
          ran("high-effort", 42, startDev, developer, "23", 8),
          ran("low-effort", 43, actOnFindings, developerOnLowEffort, "23", 10),
        ]),
      ],
    });
    assert.deepStrictEqual(
      ordered.agents.map(({ agent, models }) => [
        agent,
        models.map(({ model, tasks, mixed, medianMillis }) => [model, tasks, mixed, medianMillis]),
      ]),
      [
        [
          "developer",
          [
            // 09:00 to 14:00, from the attempt that started first.
            ["claude-opus", 1, 0, 12 * HOUR],
            ["gpt-5", 1, 1, 5 * HOUR],
          ],
        ],
      ],
    );
  });

  it("attributes each attempt to its own agent after an edit and retry picks another", () => {
    const fallback = agentOf("fallback", gpt);
    const retried = taskStatisticsView({
      window: "7d",
      now,
      usage: new Map(),
      tasks: [
        mergedTask(44, at("24T12:00"), [
          summary({
            id: "retried",
            item: 44,
            loop: startDev,
            // The run's agent after the amendment.
            agent: fallback,
            state: RunState.Succeeded.make(),
            openedAt: "24T08:00",
            closedAt: "24T10:00",
            attempts: [
              {
                worker: "w1",
                startedAt: "24T08:00",
                outcome: failed("Tests fail"),
                endedAt: "24T09:00",
                agent: developer,
              },
              { worker: "w1", startedAt: "24T09:00", outcome: succeeded, endedAt: "24T10:00" },
            ],
          }),
        ]),
      ],
    });
    assert.deepStrictEqual(
      retried.agents.map(({ agent, tasks, opened, models }) => [
        agent,
        tasks,
        opened,
        models.map(({ harness, model, tasks, mixed }) => [harness, model, tasks, mixed]),
      ]),
      [
        ["developer", 1, 1, [["claude", "claude-opus", 1, 0]]],
        ["fallback", 1, 0, [["codex", "gpt-5", 1, 0]]],
      ],
    );
  });

  it("orders agents by tasks opened, then by tasks, and models by tasks", () => {
    const auditor = agentOf("auditor", gpt);
    const triage = agentOf("triage", opus);
    const ordered = taskStatisticsView({
      window: "7d",
      now,
      usage: new Map(),
      tasks: [
        mergedTask(50, at("24T12:00"), [
          ran("ordered-gpt", 50, startDev, developerOnGpt, "24", 8),
          ran("ordered-gpt-review", 51, reviewPr, reviewer, "24", 9),
          ran("ordered-gpt-audit", 51, reviewPr, auditor, "24", 10),
        ]),
        mergedTask(52, at("23T12:00"), [
          ran("ordered-gpt-again", 52, startDev, developerOnGpt, "23", 8),
          ran("ordered-gpt-again-review", 53, reviewPr, reviewer, "23", 9),
        ]),
        mergedTask(54, at("22T12:00"), [
          ran("ordered-opus", 54, startDev, developer, "22", 8),
          ran("ordered-opus-review", 55, reviewPr, reviewer, "22", 9),
        ]),
        mergedTask(56, at("21T12:00"), [
          ran("ordered-triage", 56, startDev, triage, "21", 8),
          ran("ordered-triage-review", 57, reviewPr, reviewer, "21", 9),
        ]),
      ],
    });
    assert.deepStrictEqual(
      ordered.agents.map(({ agent, opened, tasks, models }) => [
        agent,
        opened,
        tasks,
        models.map(({ model, tasks }) => [model, tasks]),
      ]),
      [
        // The developer has fewer tasks than the reviewer, but opened more.
        [
          "developer",
          3,
          3,
          [
            ["gpt-5", 2],
            ["claude-opus", 1],
          ],
        ],
        ["triage", 1, 1, [["claude-opus", 1]]],
        // The reviewer has more tasks than the auditor, whose name sorts first.
        ["reviewer", 0, 4, [["gpt-5", 4]]],
        ["auditor", 0, 1, [["gpt-5", 1]]],
      ],
    );
  });
});

describe("Run statistics", () => {
  it("excludes handed-off runs and attempts from failure, cancellation, and attention counts", () => {
    const source = summary({
      id: "handed-off",
      item: 828,
      loop: startDev,
      agent: developer,
      state: RunState.HandedOff.make({
        reason: "CI failed: ci.",
        head: CommitSha.make("a".repeat(40)),
        fixLoop: actOnFindings,
        fixRunId: RunId.make("fix-828"),
      }),
      openedAt: "25T08:00",
      closedAt: "25T09:00",
      attempts: [
        {
          worker: "w1",
          startedAt: "25T08:01",
          endedAt: "25T09:00",
          outcome: AttemptHandedOff.make(),
        },
      ],
    });
    const view = runStatisticsView({
      window: "7d",
      now,
      runs: [source],
      usage: new Map(),
      workers,
    });
    assert.deepStrictEqual({ ...view.runs }, { succeeded: 0, failed: 0, canceled: 0 });
    assert.strictEqual(view.needsAttention.failures, 0);
    assert.deepStrictEqual(
      view.brains.map(({ outcomes }) => ({
        succeeded: outcomes.succeeded,
        failed: outcomes.failed,
        canceled: outcomes.canceled,
      })),
      [{ succeeded: 0, failed: 0, canceled: 0 }],
    );
  });
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

  it("summarizes Run and Attempt time by their median", () => {
    // Run times: 75, 20, 120, 11, 10, 60, and 30 minutes.
    assert.deepStrictEqual({ ...week.runTime }, { count: 7, medianMillis: 30 * MINUTE });
    assert.strictEqual(week.attemptTime?.count, 9);
    assert.strictEqual(week.unmeasuredAttempts, 0);
    assert.deepStrictEqual(
      { ...durationSummary([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) },
      {
        count: 10,
        medianMillis: 6,
      },
    );
    assert.isNull(durationSummary([]));
  });

  it("prices Runs whose sessions all have a price, per Loop", () => {
    const cost = (loop: LoopName) => week.loops.find((group) => group.loop === loop)?.usage.cost;
    // The Claude plan Run and the API key Run; the canceled Run has no session.
    assert.deepStrictEqual(
      [cost(startDev)?.usd, cost(startDev)?.estimate, cost(startDev)?.priced],
      [3, true, 2],
    );
    // One API key session has no price.
    assert.isNull(cost(actOnFindings));
    // The ChatGPT plan Runs with a price, one with a Claude plan child; the other has none.
    assert.deepStrictEqual(
      [cost(reviewPr)?.usd, cost(reviewPr)?.estimate, cost(reviewPr)?.priced],
      [1, true, 2],
    );
  });

  it("breaks down Runs per Loop and Agent, and Attempts per harness, model, and effort", () => {
    assert.deepStrictEqual(
      week.loops.map(({ loop, outcomes }) => [
        loop,
        { succeeded: outcomes.succeeded, failed: outcomes.failed, canceled: outcomes.canceled },
      ]),
      [
        ["review-pr", { succeeded: 3, failed: 0, canceled: 0 }],
        ["start-dev", { succeeded: 1, failed: 1, canceled: 1 }],
        ["act-on-findings", { succeeded: 1, failed: 0, canceled: 0 }],
      ],
    );
    const review = week.loops.find(({ loop }) => loop === reviewPr);
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
        { succeeded: outcomes.succeeded, failed: outcomes.failed, canceled: outcomes.canceled },
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
    // w1 grew from one slot to two after three days; its attempts occupied 156 minutes.
    const windowMillis = (6 * 24 + 12) * HOUR;
    const resizedCapacityMillis = 3 * 24 * HOUR + 2 * (3 * 24 + 12) * HOUR;
    assert.deepStrictEqual(
      week.utilization.map(({ worker, slots, occupiedMillis, share }) => [
        worker,
        slots,
        occupiedMillis,
        share,
      ]),
      [
        ["w1", 2, 127 * MINUTE + 29 * MINUTE, (156 * MINUTE) / resizedCapacityMillis],
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

  it("counts resolutions and retries separately, without unanswered failures or double counting", () => {
    const view = (runs: ReadonlyArray<RunSummary>) =>
      runStatisticsView({ window: "7d", now, runs, usage, workers }).needsAttention;
    const resolve = (run: RunSummary, number: number, resolvedAt: string) =>
      RunSummary.make({
        ...run,
        attempts: run.attempts.map((attempt) =>
          attempt.number !== number
            ? attempt
            : AttemptSummary.make({
                ...attempt,
                failureResolution: Option.some(
                  FailureResolution.make({ resolvedAt: at(resolvedAt), operator: Option.none() }),
                ),
              }),
        ),
      });
    assert.strictEqual(view([abandoned]).failureWait, null);
    const legacy = RunSummary.make({
      ...abandoned,
      resolvedFailureAttemptId: Option.some(AttemptId.make("abandoned/1")),
    });
    assert.strictEqual(view([legacy]).failureWait, null);
    const resolved = resolve(abandoned, 1, "23T15:15");
    const measured = view([resolved]);
    assert.deepStrictEqual({ ...measured.failureWait }, { count: 1, medianMillis: 15 * MINUTE });
    assert.deepStrictEqual(measured.resolutionWait, measured.failureWait);
    assert.strictEqual(measured.retryWait, null);
    const laterRetry = view([resolve(fixed, 2, "21T11:45")]);
    assert.deepStrictEqual(laterRetry.failureWait, measured.failureWait);
    assert.strictEqual(laterRetry.retryWait, null);
    const both = view([resolved, fixed]);
    assert.deepStrictEqual({ ...both.failureWait }, { count: 2, medianMillis: 37.5 * MINUTE });
    assert.deepStrictEqual({ ...both.retryWait }, { count: 1, medianMillis: 60 * MINUTE });
    assert.deepStrictEqual(both.resolutionWait, measured.resolutionWait);
  });

  it("starts the whole history at the first Run's day and splits a long one into weeks", () => {
    const old = summary({
      id: "old",
      item: 11,
      loop: startDev,
      agent: developer,
      state: RunState.Succeeded.make(),
      openedAt: "25T08:00",
      closedAt: "25T09:00",
      attempts: [{ worker: "w1", startedAt: "25T08:01", outcome: succeeded, endedAt: "25T09:00" }],
    });
    const history = runStatisticsView({
      window: "all",
      now: DateTime.makeUnsafe("2027-01-20T12:00:00.000Z"),
      runs: [old],
      usage: new Map(),
      workers,
    });
    assert.strictEqual(history.from, "2026-10-25T00:00:00.000Z");
    assert.strictEqual(history.bucket, "week");
    // 2026-10-19 is the Monday of the week of 2026-10-25.
    assert.strictEqual(history.throughput[0]?.start, "2026-10-19");
    assert.strictEqual(history.throughput[0]?.succeeded, 1);
    assert.strictEqual(history.throughput.at(-1)?.start, "2027-01-18");

    const empty = runStatisticsView({
      window: "all",
      now,
      runs: [],
      usage: new Map(),
      workers: [],
    });
    assert.strictEqual(empty.from, "2026-10-25T00:00:00.000Z");
    assert.isNull(empty.runTime);
    assert.deepStrictEqual(empty.attemptsPerRun, []);
  });
});

const tokenReport = (attempt: string, tokens: number, usd: number) =>
  TranscriptEntry.make({
    sequence: TranscriptSequence.make(1),
    attemptId: AttemptId.make(attempt),
    direction: "outbound",
    envelope: AttemptChannel.OutboundEnvelope.make({
      version: AttemptChannel.PROTOCOL_VERSION,
      attemptId: AttemptId.make(attempt),
      sequence: AttemptChannel.Sequence.make(1),
      sentAt: now,
      payload: AttemptChannel.SessionEvent.make({
        event: SessionTokensUpdated.make({
          session: ParentSession.make({
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

const instance = Effect.gen(function* () {
  const decodedValue1 = yield* Schema.decodeEffect(UsineConfig)({
    version: 1,
    repos: [{ name: repository }],
    workers: [{ name: "w1", kind: "local", max_concurrent_attempts: 2 }],
  });
  return LoadedInstance.make({
    config: decodedValue1,
    agents: [],
    invalidAgents: [],
    loops: [],
    quarantinedLoops: [],
    warnings: [],
  });
});

describe("OperatorStatistics", () => {
  it.effect(
    "reads tasks merged through linked issues with their budget resets, and the window's Runs once",
    () =>
      Effect.gen(function* () {
        const fixtureInstance = yield* instance;
        const since: Array<Option.Option<DateTime.Utc>> = [];
        const closedRuns = [implemented, firstReview, onlyReview];
        let itemReads = 0;
        let historyReads = 0;
        const reader = Layer.succeed(RunReader)({
          runForEvent: () => Effect.die("unused"),
          ciFixRuns: () => Effect.succeed(new Map()),
          latestPoolRateLimits: Effect.succeed([]),
          inspect: () => Effect.die("unused"),
          summary: () => Effect.die("unused"),
          evidence: () => Effect.die("unused"),
          // The open Runs, and a closed Run that the window read already counts.
          list: () => Effect.succeed([running, waiting, implemented]),
          closed: () => Effect.die("unused"),
          closedSince: (from) => Effect.sync(() => since.push(from)).pipe(Effect.as(closedRuns)),
          board: () => Effect.die("unused"),
          forItems: (keys) =>
            Effect.sync(() => {
              historyReads += 1;
              return [implemented, firstReview, onlyReview].filter(({ itemKey }) =>
                keys.includes(itemKey),
              );
            }),
          events: () => Effect.die("unused"),
          revision: Effect.succeedSome(ProjectionRevision.make(0)),
          transcript: (query) =>
            Effect.succeed(
              query._tag === "TranscriptUsageQuery" && query.attemptId === "implemented/1"
                ? [tokenReport("implemented/1", 100_000, 2)]
                : [],
            ),
          attemptsByWorker: Effect.die("unused"),
          sightings: () => Effect.die("unused"),
        });
        const items = Layer.succeed(ItemProjectionReader)({
          get: () => Effect.die("unused"),
          openIssues: () => Effect.die("unused"),
          list: () =>
            Effect.sync(() => {
              itemReads += 1;
              return [
                issue(1, [2]),
                mergedPullRequest(2, "2026-10-22T08:00:00Z"),
                // Merged before the window.
                mergedPullRequest(9, "2026-10-10T08:00:00Z"),
                ItemProjection.make({
                  itemKey: gitHubItemKey(repository, 12),
                  repository,
                  source: ItemProjectionSource.make("pr"),
                  number: ItemNumber.make(12),
                  contentHash: ItemContentHash.make("malformed-12"),
                  payload: { number: 12 },
                }),
              ];
            }),
        });
        const budgets = Layer.succeed(CycleBudgets)({
          ...emptyCycleBudgets,
          generation: (itemKey) =>
            Effect.succeed(CycleGeneration.make(itemKey === gitHubItemKey(repository, 1) ? 1 : 0)),
        });
        yield* TestClock.setTime(DateTime.toEpochMillis(now));
        const [tasksDone, runsClosed] = yield* OperatorStatistics.use(
          ({ statistics, runStatistics }) =>
            Effect.gen(function* () {
              const first = yield* Effect.all([
                statistics(fixtureInstance, "7d"),
                runStatistics(fixtureInstance, "7d"),
              ]);
              const repeated = yield* Effect.all([
                statistics(fixtureInstance, "7d"),
                runStatistics(fixtureInstance, "7d"),
              ]);
              assert.strictEqual(repeated[0], first[0]);
              assert.strictEqual(repeated[1], first[1]);
              return first;
            }),
        ).pipe(
          Effect.provide(
            OperatorStatistics.layer.pipe(
              Layer.provide(
                Layer.effect(
                  WorkerStatus,
                  Effect.gen(function* () {
                    const status = yield* WorkerStatus;
                    return {
                      ...status,
                      machineStarts: Effect.succeed([
                        MachineStarts.make({
                          worker: WorkerName.make("worker"),
                          provider: "boat",
                          day: DateTime.formatIso(now).slice(0, 10),
                          count: 3,
                        }),
                        MachineStarts.make({
                          worker: WorkerName.make("worker"),
                          provider: "boat",
                          day: "2020-01-01",
                          count: 7,
                        }),
                      ]),
                    };
                  }),
                ).pipe(Layer.provide(WorkerStatus.idle)),
              ),
              Layer.provide(configurationLayer),
              Layer.provide(RunUsageReader.layer),
              Layer.provide(Layer.mergeAll(reader, items, budgets)),
            ),
          ),
        );

        assert.deepStrictEqual(
          runsClosed.machineStarts.map(({ count }) => count),
          [3],
        );

        // Issue 1 and pull request 2 form the task, up to its review's close; the review reported no tokens.
        assert.deepStrictEqual(
          tasksDone.tasks.map(({ number, durationMillis }) => [number, durationMillis]),
          [[1, 26 * HOUR + 20 * MINUTE]],
        );
        assert.deepStrictEqual(
          [tasksDone.firstTimeRight, tasksDone.operatorActions, tasksDone.unmetered],
          [1, 2, 1],
        );
        assert.strictEqual(itemReads, 1);
        assert.strictEqual(historyReads, 1);
        assert.deepStrictEqual(since, [Option.some(at("19T00:00"))]);
        assert.deepStrictEqual({ ...runsClosed.runs }, { succeeded: 3, failed: 0, canceled: 0 });
        assert.strictEqual(runsClosed.needsAttention.approvals, 3);
        assert.deepStrictEqual(
          runsClosed.utilization.map(({ worker, slots }) => [worker, slots]),
          [["w1", 2]],
        );
      }),
  );
});
