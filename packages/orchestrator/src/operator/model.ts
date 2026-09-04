import { BrainSpec } from "@usine/core/agent/brain";
import { ChildSessionBudget, ChildSessionCount } from "@usine/core/agent/session";
import { AttemptNumber, AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { RunawayCeiling } from "@usine/core/attempt/failure";
import { AgentName } from "@usine/core/agent";
import { ItemKey, ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import * as RunState from "@usine/core/run/state";
import { GitHubLabelName } from "@usine/config/label";
import { LaneItemState, LaneName, LaneSource } from "@usine/config/board";
import { TranscriptSequence } from "@usine/engine/transcript";
import { Schema } from "effect";
import { LabelPreflightFinding } from "../label-reconciler.ts";
import { RepositoryPollFailure } from "../polling-triggers.ts";
import { ScheduleFailure } from "../schedule-triggers.ts";

export const ProjectStatus = Schema.Literals(["clear", "active", "needs-you"]);
export type ProjectStatus = typeof ProjectStatus.Type;

export const RunStateTag = Schema.Literals(RunState.STATE_TAGS);
export type RunStateTag = typeof RunStateTag.Type;

const NullableString = Schema.NullOr(Schema.String);

/** An infra failure as the operator sees it; the defect cause stays behind this boundary. */
export class InfraFailureView extends Schema.TaggedClass<InfraFailureView>(
  "@usine/orchestrator/InfraFailureView",
)("InfraFailure", { message: Schema.String }) {}

export class AgentFailureView extends Schema.TaggedClass<AgentFailureView>(
  "@usine/orchestrator/AgentFailureView",
)("AgentFailure", { message: Schema.String }) {}

export class RunawayFailureView extends Schema.TaggedClass<RunawayFailureView>(
  "@usine/orchestrator/RunawayFailureView",
)("RunawayFailure", { ceiling: RunawayCeiling }) {}

export class ChildSessionBudgetFailureView extends Schema.TaggedClass<ChildSessionBudgetFailureView>(
  "@usine/orchestrator/ChildSessionBudgetFailureView",
)("ChildSessionBudgetFailure", {
  maxChildren: ChildSessionBudget,
  attemptedChildren: ChildSessionCount,
}) {}

export const FailureView = Schema.Union([
  InfraFailureView,
  AgentFailureView,
  RunawayFailureView,
  ChildSessionBudgetFailureView,
]);
export type FailureView = typeof FailureView.Type;

export class SucceededAttemptView extends Schema.TaggedClass<SucceededAttemptView>(
  "@usine/orchestrator/SucceededAttemptView",
)("Succeeded", {}) {}

export class FailedAttemptView extends Schema.TaggedClass<FailedAttemptView>(
  "@usine/orchestrator/FailedAttemptView",
)("Failed", { failure: FailureView }) {}

export class CanceledAttemptView extends Schema.TaggedClass<CanceledAttemptView>(
  "@usine/orchestrator/CanceledAttemptView",
)("Canceled", {}) {}

export const AttemptOutcomeView = Schema.Union([
  SucceededAttemptView,
  FailedAttemptView,
  CanceledAttemptView,
]);
export type AttemptOutcomeView = typeof AttemptOutcomeView.Type;

export class AttemptView extends Schema.Class<AttemptView>("@usine/orchestrator/AttemptView")({
  id: AttemptId,
  number: AttemptNumber,
  worker: WorkerName,
  brain: BrainSpec,
  startedAt: Schema.String,
  outcome: Schema.NullOr(AttemptOutcomeView),
}) {}

export class RunView extends Schema.Class<RunView>("@usine/orchestrator/RunView")({
  id: RunId,
  itemKey: ItemKey,
  loop: LoopName,
  repository: RepositoryName,
  agent: AgentName,
  state: RunStateTag,
  loopPaused: Schema.Boolean,
  openedAt: Schema.String,
  task: Schema.String,
  attempts: Schema.Array(AttemptView),
  resultMessage: NullableString,
  pullRequestUrl: NullableString,
  canApprove: Schema.Boolean,
  canRetry: Schema.Boolean,
  canCancel: Schema.Boolean,
}) {}

export const BoardLaneId = Schema.NonEmptyString.pipe(Schema.brand("BoardLaneId"));
export type BoardLaneId = typeof BoardLaneId.Type;

export const BoardLaneOrigin = Schema.Literals(["authored", "proposed", "fallback"]);
export type BoardLaneOrigin = typeof BoardLaneOrigin.Type;

export class BoardItemView extends Schema.Class<BoardItemView>("@usine/orchestrator/BoardItemView")(
  {
    itemKey: ItemKey,
    kind: Schema.Literals(["issue", "pr"]),
    number: ItemNumber,
    title: Schema.String,
    url: Schema.NonEmptyString,
    state: LaneItemState,
    labels: Schema.Array(GitHubLabelName),
    /** Every retained Run for this card, each with the actions the operator can take on it. */
    runs: Schema.Array(RunView),
    run: Schema.NullOr(RunView),
    needsYou: Schema.Boolean,
  },
) {}

const BoardLaneViewFields = {
  id: BoardLaneId,
  name: LaneName,
  sources: Schema.Array(LaneSource),
  origin: BoardLaneOrigin,
  items: Schema.Array(BoardItemView),
} as const;

export class WritableBoardLaneView extends Schema.TaggedClass<WritableBoardLaneView>(
  "@usine/orchestrator/WritableBoardLaneView",
)("WritableBoardLane", {
  ...BoardLaneViewFields,
  labels: Schema.Array(GitHubLabelName).check(Schema.isNonEmpty()),
}) {}

export class ReadOnlyBoardLaneView extends Schema.TaggedClass<ReadOnlyBoardLaneView>(
  "@usine/orchestrator/ReadOnlyBoardLaneView",
)("ReadOnlyBoardLane", BoardLaneViewFields) {}

export const BoardLaneView = Schema.Union([WritableBoardLaneView, ReadOnlyBoardLaneView]);
export type BoardLaneView = typeof BoardLaneView.Type;

export class BoardProjectionError extends Schema.TaggedError<BoardProjectionError>(
  "@usine/orchestrator/BoardProjectionError",
)("BoardProjectionError", {
  repository: RepositoryName,
  itemKey: ItemKey,
  message: Schema.NonEmptyString,
}) {}

export class BoardView extends Schema.Class<BoardView>("@usine/orchestrator/BoardView")({
  lanes: Schema.Array(BoardLaneView),
  failures: Schema.Array(BoardProjectionError),
}) {}

/** A repository label as GitHub shows it. Color is null for catalogs stored before colors were kept. */
export class LabelView extends Schema.Class<LabelView>("@usine/orchestrator/LabelView")({
  name: GitHubLabelName,
  color: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
}) {}

export class ProjectView extends Schema.Class<ProjectView>("@usine/orchestrator/ProjectView")({
  repository: RepositoryName,
  status: ProjectStatus,
  runs: Schema.Array(RunView),
  board: BoardView,
  /** The repository's label catalog, used to color badges on cards and lanes. */
  labels: Schema.Array(LabelView),
  /** Failures from provisioning this Project's declared labels; they do not block the Board. */
  preflightFindings: Schema.Array(LabelPreflightFinding),
}) {}

export class BoardMove extends Schema.Class<BoardMove>("@usine/orchestrator/BoardMove")({
  repository: RepositoryName,
  item: ItemNumber,
  toLane: BoardLaneId,
}) {}

export class BoardProjectNotFoundError extends Schema.TaggedError<BoardProjectNotFoundError>(
  "@usine/orchestrator/BoardProjectNotFoundError",
)("BoardProjectNotFoundError", {
  repository: RepositoryName,
}) {}

export class BoardItemNotFoundError extends Schema.TaggedError<BoardItemNotFoundError>(
  "@usine/orchestrator/BoardItemNotFoundError",
)("BoardItemNotFoundError", {
  repository: RepositoryName,
  item: ItemNumber,
}) {}

export class BoardLaneNotFoundError extends Schema.TaggedError<BoardLaneNotFoundError>(
  "@usine/orchestrator/BoardLaneNotFoundError",
)("BoardLaneNotFoundError", {
  repository: RepositoryName,
  lane: BoardLaneId,
}) {}

export class BoardLaneReadOnlyError extends Schema.TaggedError<BoardLaneReadOnlyError>(
  "@usine/orchestrator/BoardLaneReadOnlyError",
)("BoardLaneReadOnlyError", {
  repository: RepositoryName,
  lane: BoardLaneId,
}) {}

export class LoopView extends Schema.Class<LoopView>("@usine/orchestrator/LoopView")({
  name: LoopName,
  trigger: Schema.String,
  agent: AgentName,
  paused: Schema.Boolean,
}) {}

export class ApprovalNeed extends Schema.TaggedClass<ApprovalNeed>(
  "@usine/orchestrator/ApprovalNeed",
)("ApprovalNeed", {
  id: Schema.String,
  repository: RepositoryName,
  runId: RunId,
  loop: LoopName,
}) {}

export class RunFailureNeed extends Schema.TaggedClass<RunFailureNeed>(
  "@usine/orchestrator/RunFailureNeed",
)("RunFailureNeed", {
  id: Schema.String,
  repository: RepositoryName,
  runId: RunId,
  loop: LoopName,
  failure: FailureView,
}) {}

export class PollFailureNeed extends Schema.TaggedClass<PollFailureNeed>(
  "@usine/orchestrator/PollFailureNeed",
)("PollFailureNeed", {
  id: Schema.String,
  failure: RepositoryPollFailure,
}) {}

export class PreflightFindingNeed extends Schema.TaggedClass<PreflightFindingNeed>(
  "@usine/orchestrator/PreflightFindingNeed",
)("PreflightFindingNeed", {
  id: Schema.String,
  finding: LabelPreflightFinding,
}) {}

export class BoardProjectionNeed extends Schema.TaggedClass<BoardProjectionNeed>(
  "@usine/orchestrator/BoardProjectionNeed",
)("BoardProjectionNeed", {
  id: Schema.String,
  failure: BoardProjectionError,
}) {}

export class ScheduleFailureNeed extends Schema.TaggedClass<ScheduleFailureNeed>(
  "@usine/orchestrator/ScheduleFailureNeed",
)("ScheduleFailureNeed", {
  id: Schema.String,
  failure: ScheduleFailure,
}) {}

export const NeedView = Schema.Union([
  ApprovalNeed,
  BoardProjectionNeed,
  RunFailureNeed,
  PollFailureNeed,
  PreflightFindingNeed,
  ScheduleFailureNeed,
]);
export type NeedView = typeof NeedView.Type;

export class FailedTranscriptView extends Schema.TaggedClass<FailedTranscriptView>(
  "@usine/orchestrator/FailedTranscriptView",
)("Failed", { failure: FailureView }) {}

export const TranscriptPayload = Schema.Union([
  AttemptChannel.Started,
  AttemptChannel.SessionEvent,
  AttemptChannel.Final,
  FailedTranscriptView,
  AttemptChannel.Interrupted,
  AttemptChannel.Steer,
  AttemptChannel.Interrupt,
]);
export type TranscriptPayload = typeof TranscriptPayload.Type;

export class TranscriptEventView extends Schema.Class<TranscriptEventView>(
  "@usine/orchestrator/TranscriptEventView",
)({
  sequence: TranscriptSequence,
  attemptId: AttemptId,
  receivedAt: Schema.String,
  direction: AttemptChannel.Direction,
  payload: TranscriptPayload,
}) {}

/** Where the next earlier transcript page starts, scoped to one Attempt. */
export class TranscriptPageCursor extends Schema.Class<TranscriptPageCursor>(
  "@usine/orchestrator/TranscriptPageCursor",
)({
  attemptId: AttemptId,
  before: TranscriptSequence,
}) {}

export class ColdTranscriptRequest extends Schema.TaggedClass<ColdTranscriptRequest>(
  "@usine/orchestrator/ColdTranscriptRequest",
)("ColdTranscriptRequest", {}) {}

export class TailTranscriptRequest extends Schema.TaggedClass<TailTranscriptRequest>(
  "@usine/orchestrator/TailTranscriptRequest",
)("TailTranscriptRequest", { after: TranscriptSequence }) {}

export class EarlierTranscriptRequest extends Schema.TaggedClass<EarlierTranscriptRequest>(
  "@usine/orchestrator/EarlierTranscriptRequest",
)("EarlierTranscriptRequest", {
  attemptId: AttemptId,
  before: TranscriptSequence,
}) {}

export const TranscriptRequest = Schema.Union([
  ColdTranscriptRequest,
  TailTranscriptRequest,
  EarlierTranscriptRequest,
]);
export type TranscriptRequest = typeof TranscriptRequest.Type;

export class TranscriptAttemptNotFoundError extends Schema.TaggedError<TranscriptAttemptNotFoundError>(
  "@usine/orchestrator/TranscriptAttemptNotFoundError",
)("TranscriptAttemptNotFoundError", {
  runId: RunId,
  attemptId: AttemptId,
}) {}

export class RunDetailView extends Schema.Class<RunDetailView>("@usine/orchestrator/RunDetailView")(
  {
    run: RunView,
    eventDedupKey: Schema.String,
    eventPayload: Schema.Json,
    transcript: Schema.Array(TranscriptEventView),
    earlierTranscript: Schema.Array(TranscriptPageCursor),
  },
) {}

export class ReadyOverview extends Schema.TaggedClass<ReadyOverview>(
  "@usine/orchestrator/ReadyOverview",
)("Ready", {
  projects: Schema.Array(ProjectView),
  loops: Schema.Array(LoopView),
  needsYou: Schema.Array(NeedView),
}) {}

export class NeedsSetupOverview extends Schema.TaggedClass<NeedsSetupOverview>(
  "@usine/orchestrator/NeedsSetupOverview",
)("NeedsSetup", {
  errorTag: Schema.NonEmptyString,
  projects: Schema.Array(ProjectView),
  loops: Schema.Array(LoopView),
  needsYou: Schema.Array(NeedView),
}) {}

export const FactoryOverview = Schema.Union([ReadyOverview, NeedsSetupOverview]);
export type FactoryOverview = typeof FactoryOverview.Type;
