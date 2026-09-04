import {
  Agent,
  Attempt,
  AttemptChannel,
  AttemptFailure,
  Item,
  Loop,
  Repository,
  Run,
  RunState,
  Worker,
} from "@usine/core";
import { GitHubLabelName, LaneItemState, LaneName, LaneSource } from "@usine/config";
import { TranscriptSequence } from "@usine/engine";
import { Schema } from "effect";
import { RepositoryPollFailure } from "../polling-triggers.ts";
import { ScheduleFailure } from "../schedule-triggers.ts";

/** Cursor for tailing the append-only transcript without replaying older events. */
export const TranscriptCursor = TranscriptSequence;
export type TranscriptCursor = TranscriptSequence;

export const ProjectStatus = Schema.Literals(["clear", "active", "needs-you"]);
export type ProjectStatus = typeof ProjectStatus.Type;

export const RunStateTag = Schema.Literals(RunState.STATE_TAGS);
export type RunStateTag = typeof RunStateTag.Type;

const NullableString = Schema.NullOr(Schema.String);

/** Operator-safe failure variants. Infrastructure defect causes never cross this boundary. */
export class InfraFailureView extends Schema.TaggedClass<InfraFailureView>(
  "@usine/orchestrator/InfraFailureView",
)("InfraFailure", { message: Schema.String }) {}

export class AgentFailureView extends Schema.TaggedClass<AgentFailureView>(
  "@usine/orchestrator/AgentFailureView",
)("AgentFailure", { message: Schema.String }) {}

export class RunawayFailureView extends Schema.TaggedClass<RunawayFailureView>(
  "@usine/orchestrator/RunawayFailureView",
)("RunawayFailure", { ceiling: AttemptFailure.RunawayCeiling }) {}

export class ChildSessionBudgetFailureView extends Schema.TaggedClass<ChildSessionBudgetFailureView>(
  "@usine/orchestrator/ChildSessionBudgetFailureView",
)("ChildSessionBudgetFailure", {
  maxChildren: Agent.ChildSessionBudget,
  attemptedChildren: Agent.ChildSessionCount,
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
  id: Attempt.AttemptId,
  number: Attempt.AttemptNumber,
  worker: Worker.Name,
  brain: Agent.BrainSpec,
  startedAt: Schema.String,
  outcome: Schema.NullOr(AttemptOutcomeView),
}) {}

export class RunView extends Schema.Class<RunView>("@usine/orchestrator/RunView")({
  id: Run.RunId,
  itemKey: Item.ItemKey,
  loop: Loop.LoopName,
  repository: Repository.Name,
  agent: Agent.Name,
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
    itemKey: Item.ItemKey,
    kind: Schema.Literals(["issue", "pr"]),
    number: Item.Number,
    title: Schema.String,
    url: Schema.NonEmptyString,
    state: LaneItemState,
    labels: Schema.Array(GitHubLabelName),
    /** All runs retained for a card, including every action the operator can take. */
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
  repository: Repository.Name,
  itemKey: Item.ItemKey,
  message: Schema.NonEmptyString,
}) {}

export class BoardView extends Schema.Class<BoardView>("@usine/orchestrator/BoardView")({
  lanes: Schema.Array(BoardLaneView),
  failures: Schema.Array(BoardProjectionError),
}) {}

/** A repository label as GitHub shows it; color is null for catalogs stored before colors were kept. */
export class LabelView extends Schema.Class<LabelView>("@usine/orchestrator/LabelView")({
  name: GitHubLabelName,
  color: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
}) {}

export class ProjectView extends Schema.Class<ProjectView>("@usine/orchestrator/ProjectView")({
  repository: Repository.Name,
  status: ProjectStatus,
  runs: Schema.Array(RunView),
  board: BoardView,
  /** The repository's label catalog, for coloring badges on cards and lanes. */
  labels: Schema.Array(LabelView),
}) {}

export class BoardMove extends Schema.Class<BoardMove>("@usine/orchestrator/BoardMove")({
  repository: Repository.Name,
  item: Item.Number,
  toLane: BoardLaneId,
}) {}

export class BoardProjectNotFoundError extends Schema.TaggedError<BoardProjectNotFoundError>(
  "@usine/orchestrator/BoardProjectNotFoundError",
)("BoardProjectNotFoundError", {
  repository: Repository.Name,
}) {}

export class BoardItemNotFoundError extends Schema.TaggedError<BoardItemNotFoundError>(
  "@usine/orchestrator/BoardItemNotFoundError",
)("BoardItemNotFoundError", {
  repository: Repository.Name,
  item: Item.Number,
}) {}

export class BoardLaneNotFoundError extends Schema.TaggedError<BoardLaneNotFoundError>(
  "@usine/orchestrator/BoardLaneNotFoundError",
)("BoardLaneNotFoundError", {
  repository: Repository.Name,
  lane: BoardLaneId,
}) {}

export class BoardLaneReadOnlyError extends Schema.TaggedError<BoardLaneReadOnlyError>(
  "@usine/orchestrator/BoardLaneReadOnlyError",
)("BoardLaneReadOnlyError", {
  repository: Repository.Name,
  lane: BoardLaneId,
}) {}

export class LoopView extends Schema.Class<LoopView>("@usine/orchestrator/LoopView")({
  name: Loop.LoopName,
  trigger: Schema.String,
  agent: Agent.Name,
  paused: Schema.Boolean,
}) {}

export class ApprovalNeed extends Schema.TaggedClass<ApprovalNeed>(
  "@usine/orchestrator/ApprovalNeed",
)("ApprovalNeed", {
  id: Schema.String,
  repository: Repository.Name,
  runId: Run.RunId,
  loop: Loop.LoopName,
}) {}

export class RunFailureNeed extends Schema.TaggedClass<RunFailureNeed>(
  "@usine/orchestrator/RunFailureNeed",
)("RunFailureNeed", {
  id: Schema.String,
  repository: Repository.Name,
  runId: Run.RunId,
  loop: Loop.LoopName,
  failure: FailureView,
}) {}

export class PollFailureNeed extends Schema.TaggedClass<PollFailureNeed>(
  "@usine/orchestrator/PollFailureNeed",
)("PollFailureNeed", {
  id: Schema.String,
  failure: RepositoryPollFailure,
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
  sequence: TranscriptCursor,
  attemptId: Attempt.AttemptId,
  receivedAt: Schema.String,
  direction: AttemptChannel.Direction,
  payload: TranscriptPayload,
}) {}

/** Cursor for loading one earlier page without mixing Attempts across Runs. */
export class TranscriptPageCursor extends Schema.Class<TranscriptPageCursor>(
  "@usine/orchestrator/TranscriptPageCursor",
)({
  attemptId: Attempt.AttemptId,
  before: TranscriptCursor,
}) {}

export class ColdTranscriptRequest extends Schema.TaggedClass<ColdTranscriptRequest>(
  "@usine/orchestrator/ColdTranscriptRequest",
)("ColdTranscriptRequest", {}) {}

export class TailTranscriptRequest extends Schema.TaggedClass<TailTranscriptRequest>(
  "@usine/orchestrator/TailTranscriptRequest",
)("TailTranscriptRequest", { after: TranscriptCursor }) {}

export class EarlierTranscriptRequest extends Schema.TaggedClass<EarlierTranscriptRequest>(
  "@usine/orchestrator/EarlierTranscriptRequest",
)("EarlierTranscriptRequest", {
  attemptId: Attempt.AttemptId,
  before: TranscriptCursor,
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
  runId: Run.RunId,
  attemptId: Attempt.AttemptId,
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
