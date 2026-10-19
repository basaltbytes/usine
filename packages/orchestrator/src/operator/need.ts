import { ConfigFileError } from "@usine/config/file";
import { LoopName } from "@usine/core/loop";
import { CycleBudgetAsk } from "@usine/core/cycle-budget";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import { Schema } from "effect";
import { LabelPreflightFinding } from "../label-reconciler.ts";
import { RepositoryPollFailure } from "../polling-triggers.ts";
import { ScheduleFailure } from "../schedule-triggers.ts";
import { FailureView } from "./attempt.ts";
import { BoardItemLink, BoardProjectionError } from "./board.ts";

/** An operator approval is required before this Run can proceed. */
export class ApprovalNeed extends Schema.TaggedClass<ApprovalNeed>(
  "@usine/orchestrator/ApprovalNeed",
)("ApprovalNeed", {
  id: Schema.String,
  repository: RepositoryName,
  runId: RunId,
  loop: LoopName,
  /** The Item the Run would work on, as its Board card shows it; null when no card on the
   * Project's Board holds that Item, such as for a schedule Run. */
  item: Schema.NullOr(BoardItemLink),
}) {}

/**
 * A failed Run requires an operator decision, with its displayable failure
 * details. A `QuestionFailure` is the Agent's question to the operator; its
 * Loop holds the Item until the operator answers it or the Item changes.
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

/** Repository polling failed and needs operator attention. */
export class PollFailureNeed extends Schema.TaggedClass<PollFailureNeed>(
  "@usine/orchestrator/PollFailureNeed",
)("PollFailureNeed", {
  id: Schema.String,
  failure: RepositoryPollFailure,
}) {}

/** A declared repository label could not be provisioned or confirmed. */
export class PreflightFindingNeed extends Schema.TaggedClass<PreflightFindingNeed>(
  "@usine/orchestrator/PreflightFindingNeed",
)("PreflightFindingNeed", {
  id: Schema.String,
  finding: LabelPreflightFinding,
}) {}

/** An Item could not be displayed on its Board and needs operator attention. */
export class BoardProjectionNeed extends Schema.TaggedClass<BoardProjectionNeed>(
  "@usine/orchestrator/BoardProjectionNeed",
)("BoardProjectionNeed", {
  id: Schema.String,
  failure: BoardProjectionError,
}) {}

/** A scheduled Loop could not evaluate or submit its work. */
export class ScheduleFailureNeed extends Schema.TaggedClass<ScheduleFailureNeed>(
  "@usine/orchestrator/ScheduleFailureNeed",
)("ScheduleFailureNeed", {
  id: Schema.String,
  failure: ScheduleFailure,
}) {}

/**
 * An authored file failed to load at startup and was left out: a quarantined
 * Loop opens no Runs, and an invalid Agent is not in the roster. `error` names
 * the file, the parse stage, and the reason. Fixing the file takes effect at
 * the next `usine up`.
 */
export class ConfigFileNeed extends Schema.TaggedClass<ConfigFileNeed>(
  "@usine/orchestrator/ConfigFileNeed",
)("ConfigFileNeed", {
  id: Schema.String,
  kind: Schema.Literals(["loop", "agent"]),
  error: ConfigFileError,
}) {}

/**
 * Attempts are recorded on a Worker that `usine.yaml` no longer declares.
 * Startup does not reconcile them, so any checkout they left stays on that
 * Worker. Declaring the Worker again reconciles them at the next `usine up`;
 * discarding their leftovers stops tracking them and leaves the Worker as it is.
 */
export class UnconfiguredWorkerNeed extends Schema.TaggedClass<UnconfiguredWorkerNeed>(
  "@usine/orchestrator/UnconfiguredWorkerNeed",
)("UnconfiguredWorkerNeed", {
  id: Schema.String,
  worker: WorkerName,
  /** How many Attempts recorded on the Worker startup would otherwise reconcile. */
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
}) {}

/** An Item stopped opening Runs and requires an explicit reset of its shared cycle budget. */
export class CycleBudgetNeed extends Schema.TaggedClass<CycleBudgetNeed>("CycleBudgetNeed")(
  "CycleBudgetNeed",
  {
    id: Schema.String,
    ask: CycleBudgetAsk,
    itemLabel: Schema.String,
    itemUrl: Schema.NullOr(Schema.String),
  },
) {}

/** One reason the factory asks for operator attention in the overview. */
export const NeedView = Schema.Union([
  CycleBudgetNeed,
  ApprovalNeed,
  BoardProjectionNeed,
  RunFailureNeed,
  PollFailureNeed,
  PreflightFindingNeed,
  ScheduleFailureNeed,
  ConfigFileNeed,
  UnconfiguredWorkerNeed,
]);
export type NeedView = typeof NeedView.Type;
