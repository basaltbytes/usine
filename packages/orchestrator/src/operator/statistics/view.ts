import { AgentName } from "@usine/core/agent";
import { BrainSpec } from "@usine/core/agent/brain";
import { BillingPool, TokenCount, UsdAmount } from "@usine/core/agent/session";
import { ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { WorkerName } from "@usine/core/worker";
import { Schema } from "effect";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const Milliseconds = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Share = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
/** A UTC calendar day, such as `2026-10-25`. */
const UtcDay = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u, { message: "Expected a UTC day as YYYY-MM-DD" }),
);

/** The span the statistics cover: today and the 6 or 29 UTC days before it, or every stored Run. */
export const StatisticsWindow = Schema.Literals(["7d", "30d", "all"]);
export type StatisticsWindow = typeof StatisticsWindow.Type;

/** The length of the periods in a time series: a UTC day, or a UTC week from Monday. */
export const StatisticsBucket = Schema.Literals(["day", "week"]);
export type StatisticsBucket = typeof StatisticsBucket.Type;

/**
 * A task whose pull request merged in the window. `durationMillis` runs from the opening of the
 * task's first Run to the close of its last Run, or to the merge if a Run was open at the merge or
 * closed after it. The wait between the last Run and the merge is left out.
 */
export class TaskDoneView extends Schema.Class<TaskDoneView>("@usine/orchestrator/TaskDoneView")({
  repository: RepositoryName,
  /** The task's first issue, or its first pull request if it has no issue. */
  number: ItemNumber,
  mergedAt: Schema.String,
  durationMillis: Milliseconds,
}) {}

/** The tasks done in one period. `medianMillis` is null if there are none. */
export class TaskPeriodView extends Schema.Class<TaskPeriodView>(
  "@usine/orchestrator/TaskPeriodView",
)({
  start: UtcDay,
  tasks: Count,
  medianMillis: Schema.NullOr(Milliseconds),
  firstTimeRight: Count,
  operatorActions: Count,
}) {}

/** A Loop's share of the measured tasks' time or tokens, averaged over the tasks. */
export class LoopShareView extends Schema.Class<LoopShareView>("@usine/orchestrator/LoopShareView")(
  { loop: LoopName, share: Share },
) {}

/** The median wall time of a Loop's closed Runs on the measured tasks, summed over Attempts. */
export class LoopRunTimeView extends Schema.Class<LoopRunTimeView>(
  "@usine/orchestrator/LoopRunTimeView",
)({ loop: LoopName, runs: PositiveCount, medianMillis: Milliseconds }) {}

/**
 * The time of the tasks done whose Attempts all have a recorded end. Each share is the part of a
 * task's duration that the Loop's Attempts ran, or that no Attempt ran (`waiting`: approval, queue,
 * and the time between Runs), averaged over the tasks.
 */
export class TaskTimeView extends Schema.Class<TaskTimeView>("@usine/orchestrator/TaskTimeView")({
  tasks: PositiveCount,
  loops: Schema.Array(LoopShareView),
  waiting: Share,
  runs: Schema.Array(LoopRunTimeView),
}) {}

/**
 * The median cost of the priced tasks: those whose sessions all have a price. `estimate` is true if
 * a session of a priced task is in the Claude or ChatGPT plan.
 */
export class TaskCostView extends Schema.Class<TaskCostView>("@usine/orchestrator/TaskCostView")({
  tasks: PositiveCount,
  medianUsd: UsdAmount,
  estimate: Schema.Boolean,
}) {}

/**
 * The tokens of the tasks done whose Runs with an Attempt all reported tokens, with each Loop's
 * share. `cost` is null if no such task is priced.
 */
export class TaskTokensView extends Schema.Class<TaskTokensView>(
  "@usine/orchestrator/TaskTokensView",
)({
  tasks: PositiveCount,
  medianTokens: TokenCount,
  loops: Schema.Array(LoopShareView),
  cost: Schema.NullOr(TaskCostView),
}) {}

/**
 * The tasks done with an Attempt that ended before usine recorded end times, left out of `time`.
 * Each such Attempt started before `before`.
 */
export class UntimedTasksView extends Schema.Class<UntimedTasksView>(
  "@usine/orchestrator/UntimedTasksView",
)({ tasks: PositiveCount, before: UtcDay }) {}

/**
 * The tasks done in `window`: a task is done when its pull request merges, and counts if it has a
 * Run. Runs that a newer Event or an Item change canceled before an Attempt are left out.
 */
export class StatisticsView extends Schema.Class<StatisticsView>(
  "@usine/orchestrator/StatisticsView",
)({
  window: StatisticsWindow,
  /** The window's start: midnight UTC of its first day. */
  from: Schema.String,
  /** The time the statistics were computed. */
  to: Schema.String,
  bucket: StatisticsBucket,
  /**
   * The Loops of the window's tasks in the order they first run in a task: by mean rank, from 0
   * for a task's first Loop to 1 for its last, then by name. `time` and `tokens` follow it.
   */
  loops: Schema.Array(LoopName),
  /** By merge time, oldest first. */
  tasks: Schema.Array(TaskDoneView),
  /** The median of the tasks' `durationMillis`, or null without a task. */
  medianMillis: Schema.NullOr(Milliseconds),
  /** One period per bucket from `from` to `to`, oldest first. */
  periods: Schema.Array(TaskPeriodView),
  /** The tasks with no Loop that succeeded twice on one of their Items. */
  firstTimeRight: Count,
  /**
   * The approvals, operator retries, failures marked resolved, and cycle-budget resets on the
   * tasks' Runs and Items.
   */
  operatorActions: Count,
  time: Schema.NullOr(TaskTimeView),
  tokens: Schema.NullOr(TaskTokensView),
  untimed: Schema.NullOr(UntimedTasksView),
  /** The tasks with a Run that has an Attempt but no token report, left out of `tokens`. */
  unmetered: Count,
}) {}

/** The median of at least one duration. */
export class DurationSummaryView extends Schema.Class<DurationSummaryView>(
  "@usine/orchestrator/DurationSummaryView",
)({ count: PositiveCount, medianMillis: Milliseconds }) {}

/** Closed Runs or ended Attempts counted by outcome. */
export class OutcomeCountsView extends Schema.Class<OutcomeCountsView>(
  "@usine/orchestrator/OutcomeCountsView",
)({ succeeded: Count, failed: Count, canceled: Count }) {}

/** The tokens used in one billing pool. */
export class PoolTokensView extends Schema.Class<PoolTokensView>(
  "@usine/orchestrator/PoolTokensView",
)({ pool: BillingPool, tokens: TokenCount }) {}

/**
 * The cost of the priced Runs or Attempts: those with a price for each session. `estimate` is true
 * if a priced session is in the Claude or ChatGPT plan.
 */
export class CostSummaryView extends Schema.Class<CostSummaryView>(
  "@usine/orchestrator/CostSummaryView",
)({
  usd: UsdAmount,
  meanUsd: UsdAmount,
  estimate: Schema.Boolean,
  priced: PositiveCount,
}) {}

/**
 * The tokens and cost of the Runs or Attempts with at least one Attempt. `meanTokens` is null if
 * none has one, and `cost` is null if none is priced.
 */
export class UsageSummaryView extends Schema.Class<UsageSummaryView>(
  "@usine/orchestrator/UsageSummaryView",
)({
  measured: Count,
  tokens: TokenCount,
  meanTokens: Schema.NullOr(TokenCount),
  /** In the order API keys, Claude plan, ChatGPT plan; unused pools are absent. */
  pools: Schema.Array(PoolTokensView),
  cost: Schema.NullOr(CostSummaryView),
}) {}

const groupFields = {
  outcomes: OutcomeCountsView,
  /** Run time for a Loop or Agent, Attempt time for a brain; null without a measured one. */
  time: Schema.NullOr(DurationSummaryView),
  usage: UsageSummaryView,
};

/** The closed Runs of one Loop. */
export class LoopStatisticsView extends Schema.Class<LoopStatisticsView>(
  "@usine/orchestrator/LoopStatisticsView",
)({ loop: LoopName, ...groupFields }) {}

/** The closed Runs whose effective Agent is `agent`. */
export class AgentStatisticsView extends Schema.Class<AgentStatisticsView>(
  "@usine/orchestrator/AgentStatisticsView",
)({ agent: AgentName, ...groupFields }) {}

/** The ended Attempts of closed Runs that ran with one harness, model, and effort. */
export class BrainStatisticsView extends Schema.Class<BrainStatisticsView>(
  "@usine/orchestrator/BrainStatisticsView",
)({ brain: BrainSpec, ...groupFields }) {}

/** The Runs that closed in one period, by outcome. */
export class ThroughputPeriodView extends Schema.Class<ThroughputPeriodView>(
  "@usine/orchestrator/ThroughputPeriodView",
)({ start: UtcDay, ...OutcomeCountsView.fields }) {}

/** The time from a Run's opening, or its approval, to its first Attempt's start on `worker`. */
export class WorkerQueueWaitView extends Schema.Class<WorkerQueueWaitView>(
  "@usine/orchestrator/WorkerQueueWaitView",
)({ worker: WorkerName, wait: DurationSummaryView }) {}

/** The number of closed Runs that took `attempts` Attempts. */
export class AttemptCountView extends Schema.Class<AttemptCountView>(
  "@usine/orchestrator/AttemptCountView",
)({ attempts: PositiveCount, runs: Count }) {}

/**
 * The time a declared Worker's slots held Attempts in the window, as a share of `slots` times the
 * window's length.
 */
export class WorkerUtilizationView extends Schema.Class<WorkerUtilizationView>(
  "@usine/orchestrator/WorkerUtilizationView",
)({
  worker: WorkerName,
  slots: PositiveCount,
  occupiedMillis: Milliseconds,
  share: Share,
}) {}

/** The Needs attention entries raised in one period. */
export class NeedsAttentionPeriodView extends Schema.Class<NeedsAttentionPeriodView>(
  "@usine/orchestrator/NeedsAttentionPeriodView",
)({ start: UtcDay, approvals: Count, failures: Count }) {}

/**
 * The approvals asked for and the failed Attempts that no automatic retry followed, with their
 * waits: from a run's opening to its approval, and from a failure to its first recorded operator
 * answer (retry or resolution). Each answered failure contributes once to `failureWait` and to
 * either `retryWait` or `resolutionWait`. Older resolutions without a timestamp are excluded.
 */
export class NeedsAttentionView extends Schema.Class<NeedsAttentionView>(
  "@usine/orchestrator/NeedsAttentionView",
)({
  approvals: Count,
  failures: Count,
  periods: Schema.Array(NeedsAttentionPeriodView),
  approvalWait: Schema.NullOr(DurationSummaryView),
  retryWait: Schema.NullOr(DurationSummaryView),
  resolutionWait: Schema.NullOr(DurationSummaryView),
  failureWait: Schema.NullOr(DurationSummaryView),
}) {}

/**
 * How the Runs went in `window`: closed Runs by outcome, Loop, Agent, and brain, with their time,
 * tokens, and cost, and the Worker, retry, and Needs attention measures. Runs that a newer Event or
 * an Item change canceled before an Attempt are left out.
 */
export class RunStatisticsView extends Schema.Class<RunStatisticsView>(
  "@usine/orchestrator/RunStatisticsView",
)({
  window: StatisticsWindow,
  /** The window's start: midnight UTC of its first day. */
  from: Schema.String,
  /** The time the statistics were computed. */
  to: Schema.String,
  bucket: StatisticsBucket,
  runs: OutcomeCountsView,
  /** From each closed Run's opening to its close. */
  runTime: Schema.NullOr(DurationSummaryView),
  /** From each ended Attempt's start to its recorded end. */
  attemptTime: Schema.NullOr(DurationSummaryView),
  /** The ended Attempts closed before end times were recorded, left out of `attemptTime`. */
  unmeasuredAttempts: Count,
  /** One period per bucket from `from` to `to`, oldest first. */
  throughput: Schema.Array(ThroughputPeriodView),
  /** By closed Run count, highest first. */
  loops: Schema.Array(LoopStatisticsView),
  agents: Schema.Array(AgentStatisticsView),
  brains: Schema.Array(BrainStatisticsView),
  /** For Runs whose first Attempt started in the window, by Worker name. */
  queueWait: Schema.Array(WorkerQueueWaitView),
  /** From one Attempt to the most any closed Run took, each count present. */
  attemptsPerRun: Schema.Array(AttemptCountView),
  /** For the Workers that `usine.yaml` declares, in declaration order. */
  utilization: Schema.Array(WorkerUtilizationView),
  needsAttention: NeedsAttentionView,
}) {}
