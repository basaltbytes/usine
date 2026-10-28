import { ConfigFileError } from "@usine/config/file";
import { AttemptId, AttemptNumber } from "@usine/core/attempt";
import { LoopName } from "@usine/core/loop";
import { CycleBudgetAsk } from "@usine/core/cycle-budget";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import { Schema } from "effect";
import { LabelPreflightFinding } from "../label-reconciler.ts";
import { RepositoryPollFailure } from "../polling-triggers.ts";
import { ScheduleFailure } from "../schedule-triggers.ts";
import { WorkerQuotaView } from "./machines.ts";
import { FailureView } from "./attempt.ts";
import { BoardItemLink, BoardProjectionError } from "./board.ts";

/** A Run that needs operator approval before it can proceed. */
export class ApprovalNeed extends Schema.TaggedClass<ApprovalNeed>(
  "@usine/orchestrator/ApprovalNeed",
)("ApprovalNeed", {
  id: Schema.String,
  repository: RepositoryName,
  runId: RunId,
  loop: LoopName,
  /**
   * The Run's Item as its Board card shows it, or null if no card on the Board has that Item, such
   * as for a schedule Run.
   */
  item: Schema.NullOr(BoardItemLink),
}) {}

/**
 * A failed Run that needs an operator decision. After a `QuestionFailure` or `BlockedFailure`, the
 * Item's next state opens no Run of the Loop (ADR 0017).
 */
export class RunFailureNeed extends Schema.TaggedClass<RunFailureNeed>(
  "@usine/orchestrator/RunFailureNeed",
)("RunFailureNeed", {
  id: Schema.String,
  repository: RepositoryName,
  runId: RunId,
  loop: LoopName,
  failure: FailureView,
}) {}

/** A repository poll failure that needs operator attention. */
export class PollFailureNeed extends Schema.TaggedClass<PollFailureNeed>(
  "@usine/orchestrator/PollFailureNeed",
)("PollFailureNeed", {
  id: Schema.String,
  failure: RepositoryPollFailure,
}) {}

/** A declared repository label that couldn't be created or confirmed. */
export class PreflightFindingNeed extends Schema.TaggedClass<PreflightFindingNeed>(
  "@usine/orchestrator/PreflightFindingNeed",
)("PreflightFindingNeed", {
  id: Schema.String,
  finding: LabelPreflightFinding,
}) {}

/** An Item that couldn't be shown on its Board. */
export class BoardProjectionNeed extends Schema.TaggedClass<BoardProjectionNeed>(
  "@usine/orchestrator/BoardProjectionNeed",
)("BoardProjectionNeed", {
  id: Schema.String,
  failure: BoardProjectionError,
}) {}

/** A schedule Loop that couldn't evaluate or submit its work. */
export class ScheduleFailureNeed extends Schema.TaggedClass<ScheduleFailureNeed>(
  "@usine/orchestrator/ScheduleFailureNeed",
)("ScheduleFailureNeed", {
  id: Schema.String,
  failure: ScheduleFailure,
}) {}

/**
 * An authored file that failed to load at startup and was left out: a quarantined Loop opens no
 * Runs, and an invalid Agent isn't in the roster. A fix takes effect at the next `usine up`.
 */
export class ConfigFileNeed extends Schema.TaggedClass<ConfigFileNeed>(
  "@usine/orchestrator/ConfigFileNeed",
)("ConfigFileNeed", {
  id: Schema.String,
  kind: Schema.Literals(["loop", "agent"]),
  error: ConfigFileError,
}) {}

/**
 * Attempts recorded on a Worker that `usine.yaml` no longer declares, which startup doesn't
 * reconcile. Discarding their leftovers fails while `running` is above 0.
 */
export class UnconfiguredWorkerNeed extends Schema.TaggedClass<UnconfiguredWorkerNeed>(
  "@usine/orchestrator/UnconfiguredWorkerNeed",
)(
  "UnconfiguredWorkerNeed",
  Schema.Struct({
    id: Schema.String,
    worker: WorkerName,
    /** The number of Attempts recorded on the Worker that startup would otherwise reconcile. */
    attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    /** The number of `attempts` with no recorded outcome yet. */
    running: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }).check(
    Schema.makeFilter(({ attempts, running }) => running <= attempts, {
      message: "Expected no more open attempts than attempts",
    }),
  ),
) {}

/**
 * A closed Attempt whose parent task couldn't be confirmed stopped. It is still ending on `worker`
 * and takes one of its slots until a retried stop succeeds (#475).
 */
export class UnconfirmedStopNeed extends Schema.TaggedClass<UnconfirmedStopNeed>(
  "@usine/orchestrator/UnconfirmedStopNeed",
)("UnconfirmedStopNeed", {
  id: Schema.String,
  repository: RepositoryName,
  runId: RunId,
  loop: LoopName,
  attemptNumber: AttemptNumber,
  worker: WorkerName,
}) {}

export class UnresponsiveWorkerNeed extends Schema.TaggedClass<UnresponsiveWorkerNeed>(
  "@usine/orchestrator/UnresponsiveWorkerNeed",
)("UnresponsiveWorkerNeed", {
  id: Schema.String,
  worker: WorkerName,
  lastAnsweredAt: Schema.String,
  attempts: Schema.Array(
    Schema.Struct({
      attemptId: AttemptId,
      attemptNumber: AttemptNumber,
      runId: RunId,
      repository: RepositoryName,
      loop: LoopName,
    }),
  ).check(Schema.isMinLength(1)),
}) {}

/** An Item that stopped opening Runs until the operator resets its cycle budget. */
export class CycleBudgetNeed extends Schema.TaggedClass<CycleBudgetNeed>("CycleBudgetNeed")(
  "CycleBudgetNeed",
  {
    id: Schema.String,
    ask: CycleBudgetAsk,
    itemLabel: Schema.String,
    itemUrl: Schema.NullOr(Schema.String),
  },
) {}

export class WorkerQuotaNeed extends Schema.TaggedClass<WorkerQuotaNeed>(
  "@usine/orchestrator/WorkerQuotaNeed",
)("WorkerQuotaNeed", {
  id: Schema.String,
  quota: WorkerQuotaView,
  runs: Schema.Array(Schema.Struct({ runId: RunId, repository: RepositoryName })),
}) {}

/** One reason the overview asks for operator attention. */
export const NeedView = Schema.Union([
  WorkerQuotaNeed,
  CycleBudgetNeed,
  ApprovalNeed,
  BoardProjectionNeed,
  RunFailureNeed,
  PollFailureNeed,
  PreflightFindingNeed,
  ScheduleFailureNeed,
  ConfigFileNeed,
  UnconfiguredWorkerNeed,
  UnconfirmedStopNeed,
  UnresponsiveWorkerNeed,
]);
export type NeedView = typeof NeedView.Type;
