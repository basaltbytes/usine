import {
  Agent,
  Attempt,
  AttemptChannel,
  AttemptFailure,
  Loop,
  Repository,
  Run,
  RunState,
  Worker,
} from "@usine/core";
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

export class AttemptView extends Schema.Class<AttemptView>(
  "@usine/orchestrator/AttemptView",
)({
  id: Attempt.AttemptId,
  number: Attempt.AttemptNumber,
  worker: Worker.Name,
  brain: Agent.BrainSpec,
  startedAt: Schema.String,
  outcome: Schema.NullOr(Attempt.Outcome),
}) {}

export class RunView extends Schema.Class<RunView>(
  "@usine/orchestrator/RunView",
)({
  id: Run.RunId,
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

export class ProjectView extends Schema.Class<ProjectView>(
  "@usine/orchestrator/ProjectView",
)({
  repository: Repository.Name,
  status: ProjectStatus,
  runs: Schema.Array(RunView),
}) {}

export class LoopView extends Schema.Class<LoopView>(
  "@usine/orchestrator/LoopView",
)({
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
  failure: AttemptFailure.AttemptFailure,
}) {}

export class PollFailureNeed extends Schema.TaggedClass<PollFailureNeed>(
  "@usine/orchestrator/PollFailureNeed",
)("PollFailureNeed", {
  id: Schema.String,
  failure: RepositoryPollFailure,
}) {}

export class ScheduleFailureNeed extends Schema.TaggedClass<ScheduleFailureNeed>(
  "@usine/orchestrator/ScheduleFailureNeed",
)("ScheduleFailureNeed", {
  id: Schema.String,
  failure: ScheduleFailure,
}) {}

export const NeedView = Schema.Union([
  ApprovalNeed,
  RunFailureNeed,
  PollFailureNeed,
  ScheduleFailureNeed,
]);
export type NeedView = typeof NeedView.Type;

export const TranscriptPayload = Schema.Union([
  AttemptChannel.OutboundPayload,
  AttemptChannel.InboundPayload,
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

export class RunDetailView extends Schema.Class<RunDetailView>(
  "@usine/orchestrator/RunDetailView",
)({
  run: RunView,
  eventDedupKey: Schema.String,
  eventPayload: Schema.Json,
  transcript: Schema.Array(TranscriptEventView),
  earlierTranscript: Schema.Array(TranscriptPageCursor),
}) {}

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

export const FactoryOverview = Schema.Union([
  ReadyOverview,
  NeedsSetupOverview,
]);
export type FactoryOverview = typeof FactoryOverview.Type;
