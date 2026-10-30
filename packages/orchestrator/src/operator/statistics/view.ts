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
/** The span the statistics cover: today and the 6 or 29 UTC days before it, or every stored run. */
export type StatisticsWindow = typeof StatisticsWindow.Type;

/** The length of the periods in a time series: a UTC day, or a UTC week from Monday. */
export const StatisticsBucket = Schema.Literals(["day", "week"]);
/** The length of the periods in a time series: a UTC day, or a UTC week from Monday. */
export type StatisticsBucket = typeof StatisticsBucket.Type;

/**
 * A task whose pull request merged in the window. `durationMillis` runs from the opening of the
 * task's first Run to the close of its last Run, or to the merge if a Run was open at the merge or
 * closed after it. The wait between the last Run and the merge is left out.
 */
export class TaskDoneView extends Schema.Class<TaskDoneView>("@usine/orchestrator/TaskDoneView")({
  /** The managed repo, in `owner/name` form. */
  repository: RepositoryName,
  /** The task's first issue, or its first pull request if it has no issue. */
  number: ItemNumber,
  /** The pull request merge time as an ISO 8601 timestamp. */
  mergedAt: Schema.String,
  /**
   * The measured task duration in milliseconds, excluding the wait from its last closed run to
   * merge.
   */
  durationMillis: Milliseconds,
}) {}

/** The tasks done in one period. `medianMillis` is null if there are none. */
export class TaskPeriodView extends Schema.Class<TaskPeriodView>(
  "@usine/orchestrator/TaskPeriodView",
)({
  /** The first UTC day of the period as `YYYY-MM-DD`. */
  start: UtcDay,
  /** The number of tasks whose pull request merged in this period. */
  tasks: Count,
  /** The median task duration in milliseconds, or null without a task. */
  medianMillis: Schema.NullOr(Milliseconds),
  /** The tasks where no loop succeeded twice on the same item. */
  firstTimeRight: Count,
  /** The approvals, retries, failure resolutions, and cycle-budget resets for these tasks. */
  operatorActions: Count,
}) {}

/** A Loop's share of the measured tasks' time or tokens, averaged over the tasks. */
export class LoopShareView extends Schema.Class<LoopShareView>("@usine/orchestrator/LoopShareView")(
  {
    /** The project-qualified loop name. */
    loop: LoopName,
    /** The average share of measured task time or tokens, from 0 to 1. */
    share: Share,
  },
) {}

/** The median wall time of a Loop's closed Runs on the measured tasks, summed over Attempts. */
export class LoopRunTimeView extends Schema.Class<LoopRunTimeView>(
  "@usine/orchestrator/LoopRunTimeView",
)({
  /** The project-qualified loop name. */
  loop: LoopName,
  /** The number of closed runs included in this median. */
  runs: PositiveCount,
  /** The median summed attempt wall time per closed run, in milliseconds. */
  medianMillis: Milliseconds,
}) {}

/**
 * The time of the tasks done whose Attempts all have a recorded end. Each share is the part of a
 * task's duration that the Loop's Attempts ran, or that no Attempt ran (`waiting`: approval, queue,
 * and the time between Runs), averaged over the tasks.
 */
export class TaskTimeView extends Schema.Class<TaskTimeView>("@usine/orchestrator/TaskTimeView")({
  /** The number of tasks with complete attempt end times. */
  tasks: PositiveCount,
  /** The average share per loop of measured task duration. */
  loops: Schema.Array(LoopShareView),
  /** The average fraction of task duration with no attempt running, from 0 to 1. */
  waiting: Share,
  /** Per-loop counts and median summed attempt time for closed runs. */
  runs: Schema.Array(LoopRunTimeView),
}) {}

/**
 * The median cost of the priced tasks: those whose sessions all have a price. `estimate` is true if
 * a session of a priced task is in the Claude or ChatGPT plan.
 */
export class TaskCostView extends Schema.Class<TaskCostView>("@usine/orchestrator/TaskCostView")({
  /** The number of measured tasks with a price for every session. */
  tasks: PositiveCount,
  /** The median total cost per priced task in US dollars. */
  medianUsd: UsdAmount,
  /** Whether any priced task includes subscription-plan usage estimated at API rates. */
  estimate: Schema.Boolean,
}) {}

/**
 * The tokens of the tasks done whose Runs with an Attempt all reported tokens, with each Loop's
 * share. `cost` is null if no such task is priced.
 */
export class TaskTokensView extends Schema.Class<TaskTokensView>(
  "@usine/orchestrator/TaskTokensView",
)({
  /** The number of tasks with token reports for every run that has an attempt. */
  tasks: PositiveCount,
  /** The median total reported tokens per measured task. */
  medianTokens: TokenCount,
  /** The average share per loop of measured task tokens. */
  loops: Schema.Array(LoopShareView),
  /** Cost statistics for fully priced measured tasks, or null without one. */
  cost: Schema.NullOr(TaskCostView),
}) {}

/**
 * The tasks done with an Attempt that ended before usine recorded end times, left out of `time`.
 * Each such Attempt started before `before`.
 */
export class UntimedTasksView extends Schema.Class<UntimedTasksView>(
  "@usine/orchestrator/UntimedTasksView",
)({
  /** The number of tasks excluded from time statistics because an attempt has no recorded end. */
  tasks: PositiveCount,
  /** The UTC day after the latest start of an attempt with no recorded end, as `YYYY-MM-DD`. */
  before: UtcDay,
}) {}

/**
 * The tasks done in `window`: a task is done when its pull request merges, and counts if it has a
 * Run. Runs that a newer Event or an Item change canceled before an Attempt are left out.
 */
export class StatisticsView extends Schema.Class<StatisticsView>(
  "@usine/orchestrator/StatisticsView",
)({
  /** The requested UTC date window. */
  window: StatisticsWindow,
  /** The window's start: midnight UTC of its first day. */
  from: Schema.String,
  /** The time the statistics were computed. */
  to: Schema.String,
  /** The daily or Monday-based weekly grouping used by time series. */
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
  /** Time statistics for tasks with complete attempt durations, or null without one. */
  time: Schema.NullOr(TaskTimeView),
  /** Token statistics for fully metered tasks, or null without one. */
  tokens: Schema.NullOr(TaskTokensView),
  /** Tasks excluded from duration statistics, or null when all tasks have recorded attempt ends. */
  untimed: Schema.NullOr(UntimedTasksView),
  /** The tasks with a Run that has an Attempt but no token report, left out of `tokens`. */
  unmetered: Count,
}) {}

/** The median of at least one duration. */
export class DurationSummaryView extends Schema.Class<DurationSummaryView>(
  "@usine/orchestrator/DurationSummaryView",
)({
  /** The number of durations included in the median. */
  count: PositiveCount,
  /** The median duration in milliseconds. */
  medianMillis: Milliseconds,
}) {}

/** Closed Runs or ended Attempts counted by outcome. */
export class OutcomeCountsView extends Schema.Class<OutcomeCountsView>(
  "@usine/orchestrator/OutcomeCountsView",
)({
  /** The number of successful terminal outcomes. */
  succeeded: Count,
  /** The number of failed terminal outcomes. */
  failed: Count,
  /** The number of canceled terminal outcomes. */
  canceled: Count,
}) {}

/** The tokens used in one billing pool. */
export class PoolTokensView extends Schema.Class<PoolTokensView>(
  "@usine/orchestrator/PoolTokensView",
)({
  /** The billing source for this usage. */
  pool: BillingPool,
  /** The total reported tokens, summed once per session. */
  tokens: TokenCount,
}) {}

/**
 * The cost of the priced Runs or Attempts: those with a price for each session. `estimate` is true
 * if a priced session is in the Claude or ChatGPT plan.
 */
export class CostSummaryView extends Schema.Class<CostSummaryView>(
  "@usine/orchestrator/CostSummaryView",
)({
  /** The total cost of fully priced entries in US dollars. */
  usd: UsdAmount,
  /** The mean cost per fully priced run or attempt in US dollars. */
  meanUsd: UsdAmount,
  /** Whether any included cost estimates subscription-plan usage. */
  estimate: Schema.Boolean,
  /** The number of entries with a price for every session. */
  priced: PositiveCount,
}) {}

/**
 * The tokens and cost of the Runs or Attempts with at least one Attempt. `meanTokens` is null if
 * none has one, and `cost` is null if none is priced.
 */
export class UsageSummaryView extends Schema.Class<UsageSummaryView>(
  "@usine/orchestrator/UsageSummaryView",
)({
  /** The number of entries with at least one attempt. */
  measured: Count,
  /** The total reported tokens, summed once per session. */
  tokens: TokenCount,
  /** Mean reported tokens per measured entry, or null without a measured entry. */
  meanTokens: Schema.NullOr(TokenCount),
  /** In the order API keys, Claude plan, ChatGPT plan; unused pools are absent. */
  pools: Schema.Array(PoolTokensView),
  /** Costs for fully priced entries, or null without one. */
  cost: Schema.NullOr(CostSummaryView),
}) {}

const groupFields = {
  outcomes: OutcomeCountsView,
  /** Run time for a Loop or Agent, Attempt time for a brain; null without a measured one. */
  time: Schema.NullOr(DurationSummaryView),
  usage: UsageSummaryView,
};

/**
 * The closed Runs of one Loop.
 *
 * @property outcomes - Terminal outcomes counted for this group.
 * @property time - Run time for a loop or agent, or attempt time for a brain, in milliseconds; null
 * without a measured entry.
 * @property usage - Reported tokens and priced costs for this group.
 */
export class LoopStatisticsView extends Schema.Class<LoopStatisticsView>(
  "@usine/orchestrator/LoopStatisticsView",
)({
  /** The project-qualified loop name. */
  loop: LoopName,
  ...groupFields,
}) {}

/**
 * The closed Runs whose effective Agent is `agent`.
 *
 * @property outcomes - Terminal outcomes counted for this group.
 * @property time - Run time for a loop or agent, or attempt time for a brain, in milliseconds; null
 * without a measured entry.
 * @property usage - Reported tokens and priced costs for this group.
 */
export class AgentStatisticsView extends Schema.Class<AgentStatisticsView>(
  "@usine/orchestrator/AgentStatisticsView",
)({
  /** The referenced agent name. */
  agent: AgentName,
  ...groupFields,
}) {}

/**
 * The ended Attempts of closed Runs that ran with one harness, model, and effort.
 *
 * @property outcomes - Terminal outcomes counted for this group.
 * @property time - Run time for a loop or agent, or attempt time for a brain, in milliseconds; null
 * without a measured entry.
 * @property usage - Reported tokens and priced costs for this group.
 */
export class BrainStatisticsView extends Schema.Class<BrainStatisticsView>(
  "@usine/orchestrator/BrainStatisticsView",
)({
  /** The harness, model, and reasoning effort shared by the grouped attempts. */
  brain: BrainSpec,
  ...groupFields,
}) {}

/**
 * The Runs that closed in one period, by outcome.
 *
 * @property succeeded - The number of successful terminal outcomes.
 * @property failed - The number of failed terminal outcomes.
 * @property canceled - The number of canceled terminal outcomes.
 */
export class ThroughputPeriodView extends Schema.Class<ThroughputPeriodView>(
  "@usine/orchestrator/ThroughputPeriodView",
)({
  /** The first UTC day of this period as `YYYY-MM-DD`. */
  start: UtcDay,
  ...OutcomeCountsView.fields,
}) {}

/** The time from a Run's opening, or its approval, to its first Attempt's start on `worker`. */
export class WorkerQueueWaitView extends Schema.Class<WorkerQueueWaitView>(
  "@usine/orchestrator/WorkerQueueWaitView",
)({
  /** The configured worker name. */
  worker: WorkerName,
  /** Durations from run opening or approval to the first attempt start. */
  wait: DurationSummaryView,
}) {}

/** The number of closed Runs that took `attempts` Attempts. */
export class AttemptCountView extends Schema.Class<AttemptCountView>(
  "@usine/orchestrator/AttemptCountView",
)({
  /** The number of attempts taken by each run in this group. */
  attempts: PositiveCount,
  /** The number of closed runs with this attempt count. */
  runs: Count,
}) {}

/**
 * Attempt time as a share of the worker's slot-time capacity over the window. Configuration
 * revisions determine capacity; `slots` is the current slot count.
 */
export class WorkerUtilizationView extends Schema.Class<WorkerUtilizationView>(
  "@usine/orchestrator/WorkerUtilizationView",
)({
  /** The configured worker name. */
  worker: WorkerName,
  /** The currently configured slot count; historical revisions determine the denominator. */
  slots: PositiveCount,
  /** The attempt time overlapping the window, summed across occupied slots in milliseconds. */
  occupiedMillis: Milliseconds,
  /** Occupied attempt time divided by historical slot-time capacity, from 0 to 1. */
  share: Share,
}) {}

/** The Needs attention entries raised in one period. */
export class NeedsAttentionPeriodView extends Schema.Class<NeedsAttentionPeriodView>(
  "@usine/orchestrator/NeedsAttentionPeriodView",
)({
  /** The first UTC day of the period as `YYYY-MM-DD`. */
  start: UtcDay,
  /** The number of approval requests raised in this period. */
  approvals: Count,
  /** The number of failed attempts without an automatic retry raised in this period. */
  failures: Count,
}) {}

/**
 * The approvals asked for and the failed Attempts that no automatic retry followed, with their
 * waits: from a run's opening to its approval, and from a failure to its first recorded operator
 * answer (retry or resolution). Each answered failure contributes once to `failureWait` and to
 * either `retryWait` or `resolutionWait`. Older resolutions without a timestamp are excluded.
 */
export class NeedsAttentionView extends Schema.Class<NeedsAttentionView>(
  "@usine/orchestrator/NeedsAttentionView",
)({
  /** The number of approval requests in the window. */
  approvals: Count,
  /** The number of failed attempts without an automatic retry in the window. */
  failures: Count,
  /** Attention counts by period, oldest first. */
  periods: Schema.Array(NeedsAttentionPeriodView),
  /** Waits from run opening to approval, or null without a recorded approval. */
  approvalWait: Schema.NullOr(DurationSummaryView),
  /** Waits from failure to an operator retry as the first answer, or null without one. */
  retryWait: Schema.NullOr(DurationSummaryView),
  /** Waits from failure to a recorded resolution as the first answer, or null without one. */
  resolutionWait: Schema.NullOr(DurationSummaryView),
  /**
   * Waits from failure to the first operator retry or timestamped resolution, counting each
   * answered failure once; null without one.
   */
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
  /** The requested UTC date window. */
  window: StatisticsWindow,
  /** The window's start: midnight UTC of its first day. */
  from: Schema.String,
  /** The time the statistics were computed. */
  to: Schema.String,
  /** The daily or Monday-based weekly grouping used by time series. */
  bucket: StatisticsBucket,
  /** Closed runs counted by terminal outcome. */
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
  /** Statistics grouped by effective agent, ordered by closed run count. */
  agents: Schema.Array(AgentStatisticsView),
  /** Statistics grouped by attempt harness, model, and effort. */
  brains: Schema.Array(BrainStatisticsView),
  /** For Runs whose first Attempt started in the window, by Worker name. */
  queueWait: Schema.Array(WorkerQueueWaitView),
  /** From one Attempt to the most any closed Run took, each count present. */
  attemptsPerRun: Schema.Array(AttemptCountView),
  /** For the Workers that `usine.yaml` declares, in declaration order. */
  utilization: Schema.Array(WorkerUtilizationView),
  /** Approval and failure counts with the waits for recorded operator answers. */
  needsAttention: NeedsAttentionView,
}) {}
