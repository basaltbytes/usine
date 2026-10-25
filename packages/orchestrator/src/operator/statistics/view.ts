import { AgentName } from "@usine/core/agent";
import { BrainSpec } from "@usine/core/agent/brain";
import { BillingPool, TokenCount, UsdAmount } from "@usine/core/agent/session";
import { LoopName } from "@usine/core/loop";
import { WorkerName } from "@usine/core/worker";
import { Schema } from "effect";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
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

/** The mean, median, and 90th percentile of at least one duration. */
export class DurationSummaryView extends Schema.Class<DurationSummaryView>(
  "@usine/orchestrator/DurationSummaryView",
)({
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  meanMillis: Milliseconds,
  medianMillis: Milliseconds,
  p90Millis: Milliseconds,
}) {}

/** Closed Runs or ended Attempts counted by outcome. */
export class OutcomeCountsView extends Schema.Class<OutcomeCountsView>(
  "@usine/orchestrator/OutcomeCountsView",
)({ succeeded: Count, failed: Count, canceled: Count }) {}

/** The tokens used in one billing pool. */
export class PoolTokensView extends Schema.Class<PoolTokensView>(
  "@usine/orchestrator/PoolTokensView",
)({ pool: BillingPool, tokens: TokenCount }) {}

/**
 * The cost of the priced Runs or Attempts: those with a session in the API keys or Claude plan pool
 * and a price for each such session. ChatGPT plan sessions have no dollar rate and add no cost.
 * `estimate` is true if a priced session is in the Claude plan.
 */
export class CostSummaryView extends Schema.Class<CostSummaryView>(
  "@usine/orchestrator/CostSummaryView",
)({
  usd: UsdAmount,
  meanUsd: UsdAmount,
  estimate: Schema.Boolean,
  priced: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
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

/**
 * The merged pull requests of Tasks with a Run, and how many merged with no Loop running twice on
 * an Item of the Task.
 */
export class FirstPassView extends Schema.Class<FirstPassView>("@usine/orchestrator/FirstPassView")(
  { merged: Count, firstPass: Count },
) {}

/** The time from a Run's opening, or its approval, to its first Attempt's start on `worker`. */
export class WorkerQueueWaitView extends Schema.Class<WorkerQueueWaitView>(
  "@usine/orchestrator/WorkerQueueWaitView",
)({ worker: WorkerName, wait: DurationSummaryView }) {}

/** The number of closed Runs that took `attempts` Attempts. */
export class AttemptCountView extends Schema.Class<AttemptCountView>(
  "@usine/orchestrator/AttemptCountView",
)({ attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)), runs: Count }) {}

/**
 * The time a declared Worker's slots held Attempts in the window, as a share of `slots` times the
 * window's length.
 */
export class WorkerUtilizationView extends Schema.Class<WorkerUtilizationView>(
  "@usine/orchestrator/WorkerUtilizationView",
)({
  worker: WorkerName,
  slots: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  occupiedMillis: Milliseconds,
  share: Share,
}) {}

/** The Needs attention entries raised in one period. */
export class NeedsAttentionPeriodView extends Schema.Class<NeedsAttentionPeriodView>(
  "@usine/orchestrator/NeedsAttentionPeriodView",
)({ start: UtcDay, approvals: Count, failures: Count }) {}

/**
 * The approvals asked for and the failed Attempts that no automatic retry followed, with their
 * waits: from a Run's opening to its approval, and from a failure to the operator's retry. Marking
 * a failure resolved records no time, so `retryWait` leaves those out.
 */
export class NeedsAttentionView extends Schema.Class<NeedsAttentionView>(
  "@usine/orchestrator/NeedsAttentionView",
)({
  approvals: Count,
  failures: Count,
  periods: Schema.Array(NeedsAttentionPeriodView),
  approvalWait: Schema.NullOr(DurationSummaryView),
  retryWait: Schema.NullOr(DurationSummaryView),
}) {}

/**
 * How the factory ran in `window`: closed Runs by outcome, Loop, Agent, and brain, with their time,
 * tokens, and cost, and the Worker, retry, pull request, and Needs attention measures. Runs that
 * a newer Event or an Item change canceled before an Attempt are left out.
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
  runs: OutcomeCountsView,
  /** From each closed Run's opening to its close. */
  runTime: Schema.NullOr(DurationSummaryView),
  /** From each ended Attempt's start to its recorded end. */
  attemptTime: Schema.NullOr(DurationSummaryView),
  /** The ended Attempts closed before end times were recorded, left out of `attemptTime`. */
  unmeasuredAttempts: Count,
  usage: UsageSummaryView,
  /** One period per bucket from `from` to `to`, oldest first. */
  throughput: Schema.Array(ThroughputPeriodView),
  firstPass: FirstPassView,
  /** From the first Run on a Task to the merge of its pull request, for pull requests merged in the window. */
  leadTime: Schema.NullOr(DurationSummaryView),
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
