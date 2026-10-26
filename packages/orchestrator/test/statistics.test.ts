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
        : new UsageCostView({ usd: UsdAmount.make(usd), estimate: pool !== "apiKeys" }),
  });
const usageOf = (sessions: ReadonlyArray<SessionUsageView>) =>
  new RunUsageView({
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
// Its Attempt ended before usine recorded end times.
const unrecordedEnd = summary({
  id: "unrecorded-end",
  item: 12,
  loop: startDev,
  agent: developer,
  state: new RunState.Succeeded(),
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
  { name: WorkerName.make("w1"), slots: 2 },
  { name: WorkerName.make("w2"), slots: 1 },
  { name: WorkerName.make("idle"), slots: 1 },
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
  it("counts the tasks merged in the window, from the first Run's opening to the merge", () => {
    assert.strictEqual(done.from, "2026-10-19T00:00:00.000Z");
    assert.deepStrictEqual(
      done.tasks.map(({ number, mergedAt, durationMillis }) => [number, mergedAt, durationMillis]),
      [
        [1, "2026-10-22T08:00:00.000Z", 48 * HOUR],
        [12, "2026-10-23T12:00:00.000Z", 99 * HOUR],
        [8, "2026-10-24T08:00:00.000Z", 216 * HOUR],
      ],
    );
    assert.strictEqual(done.medianMillis, 99 * HOUR);
    assert.deepStrictEqual(
      done.periods.flatMap(({ start, tasks, medianMillis, firstTimeRight, operatorActions }) =>
        tasks === 0 ? [] : [[start, tasks, medianMillis, firstTimeRight, operatorActions]],
      ),
      [
        ["2026-10-22", 1, 48 * HOUR, 0, 3],
        ["2026-10-23", 1, 99 * HOUR, 1, 0],
        ["2026-10-24", 1, 216 * HOUR, 1, 0],
      ],
    );
  });

  it("counts a second successful Run of a Loop as a round, and the operator's actions", () => {
    assert.strictEqual(done.firstTimeRight, 2);
    // The approval, the retry after the agent failure, and the reset.
    assert.strictEqual(done.operatorActions, 3);
  });

  it("splits task time between the Loops' Attempts and the waits, in the Loops' order", () => {
    // 2,880 minutes from the first Run to the merge, and 12,960 for the task that opened earlier.
    const first = (minutes: number) => (minutes * MINUTE) / (48 * HOUR);
    const second = (minutes: number) => (minutes * MINUTE) / (216 * HOUR);
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
    assert.closeTo(done.time?.waiting ?? 0, (first(2733) + second(12872)) / 2, 1e-9);
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

  it("measures tokens per task without a money figure unless every session has a price", () => {
    assert.strictEqual(done.unmetered, 1);
    assert.strictEqual(done.tokens?.tasks, 2);
    assert.strictEqual(done.tokens?.medianTokens, (241_000 + 80_000) / 2);
    const shares = new Map(done.tokens?.loops.map(({ loop, share }) => [loop, share]));
    assert.closeTo(shares.get(startDev) ?? 0, (100 / 241 + 1) / 2, 1e-9);
    assert.closeTo(shares.get(reviewPr) ?? 0, 90 / 241 / 2, 1e-9);
    assert.closeTo(shares.get(actOnFindings) ?? 0, 51 / 241 / 2, 1e-9);
    assert.isNull(done.tokens?.cost);
  });

  it("shares overlapping Attempts, prices fully priced tasks, and splits a long history into weeks", () => {
    const develop = summary({
      id: "develop",
      item: 20,
      loop: startDev,
      agent: developer,
      state: new RunState.Succeeded(),
      openedAt: "25T08:00",
      closedAt: "25T10:00",
      attempts: [{ worker: "w1", startedAt: "25T08:00", outcome: succeeded, endedAt: "25T10:00" }],
    });
    const review = summary({
      id: "review",
      item: 21,
      loop: reviewPr,
      agent: reviewer,
      state: new RunState.Succeeded(),
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
    // Each Loop ran 60 minutes alone and shared 60 more, out of 720.
    assert.deepStrictEqual(
      history.time?.loops.map(({ loop, share }) => [loop, share]),
      [
        [startDev, 90 / 720],
        [reviewPr, 90 / 720],
      ],
    );
    assert.strictEqual(history.time?.waiting, 540 / 720);
    assert.deepStrictEqual({ ...history.tokens?.cost }, { medianUsd: 1.5, estimate: true });

    const empty = taskStatisticsView({ window: "all", now, tasks: [], usage });
    assert.strictEqual(empty.from, "2026-10-25T00:00:00.000Z");
    assert.deepStrictEqual(
      [empty.medianMillis, empty.time, empty.tokens, empty.untimed],
      [null, null, null, null],
    );
  });
});

describe("Run statistics", () => {
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
      week.loops.map(({ loop, outcomes }) => [loop, { ...outcomes }]),
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
    "reads tasks merged through linked issues with their budget resets, and the window's Runs once",
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
        const budgets = Layer.succeed(CycleBudgets)({
          ...emptyCycleBudgets,
          generation: (itemKey) =>
            Effect.succeed(CycleGeneration.make(itemKey === gitHubItemKey(repository, 1) ? 1 : 0)),
        });
        yield* TestClock.setTime(DateTime.toEpochMillis(now));
        const [tasksDone, runsClosed] = yield* OperatorStatistics.use(
          ({ statistics, runStatistics }) =>
            Effect.all([statistics(instance, "7d"), runStatistics(instance, "7d")]),
        ).pipe(
          Effect.provide(
            OperatorStatistics.layer.pipe(
              Layer.provide(RunUsageReader.layer),
              Layer.provide(Layer.mergeAll(reader, items, budgets)),
            ),
          ),
        );

        // Issue 1 and pull request 2 form the task; its review reported no tokens.
        assert.deepStrictEqual(
          tasksDone.tasks.map(({ number, durationMillis }) => [number, durationMillis]),
          [[1, 48 * HOUR]],
        );
        assert.deepStrictEqual(
          [tasksDone.firstTimeRight, tasksDone.operatorActions, tasksDone.unmetered],
          [1, 2, 1],
        );
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
