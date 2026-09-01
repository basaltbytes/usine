import { Agent, Attempt, Loop, Repository, Run, RunState } from "@usine/core";
import { TranscriptSequence } from "@usine/engine";
import { Schema } from "effect";

/** Cursor for tailing the append-only transcript without replaying older events. */
export const TranscriptCursor = TranscriptSequence;
export type TranscriptCursor = TranscriptSequence;

export const ProjectStatus = Schema.Literals(["clear", "active", "needs-you"]);
export type ProjectStatus = typeof ProjectStatus.Type;

export const NeedKind = Schema.Literals([
  "approval",
  "run-failure",
  "poll-failure",
  "schedule-failure",
]);
export type NeedKind = typeof NeedKind.Type;

export const TranscriptScope = Schema.Literals(["parent", "child", "channel"]);
export type TranscriptScope = typeof TranscriptScope.Type;

export const RunStateTag = Schema.Literals(RunState.STATE_TAGS);
export type RunStateTag = typeof RunStateTag.Type;

const NullableString = Schema.NullOr(Schema.String);

export class AttemptView extends Schema.Class<AttemptView>("@usine/orchestrator/AttemptView")({
  id: Attempt.AttemptId,
  number: Attempt.AttemptNumber,
  worker: Schema.String,
  brain: Schema.String,
  startedAt: Schema.String,
  outcome: NullableString,
  errorTag: NullableString,
  errorMessage: NullableString,
}) {}

export class RunView extends Schema.Class<RunView>("@usine/orchestrator/RunView")({
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

export class ProjectView extends Schema.Class<ProjectView>("@usine/orchestrator/ProjectView")({
  repository: Repository.Name,
  status: ProjectStatus,
  runs: Schema.Array(RunView),
}) {}

export class LoopView extends Schema.Class<LoopView>("@usine/orchestrator/LoopView")({
  name: Loop.LoopName,
  trigger: Schema.String,
  agent: Agent.Name,
  paused: Schema.Boolean,
}) {}

export class NeedView extends Schema.Class<NeedView>("@usine/orchestrator/NeedView")({
  id: Schema.String,
  kind: NeedKind,
  title: Schema.String,
  detail: Schema.String,
  repository: Schema.NullOr(Repository.Name),
  runId: Schema.NullOr(Run.RunId),
  loop: Schema.NullOr(Loop.LoopName),
}) {}

export class TranscriptEventView extends Schema.Class<TranscriptEventView>(
  "@usine/orchestrator/TranscriptEventView",
)({
  sequence: Schema.Int,
  attemptId: Attempt.AttemptId,
  receivedAt: Schema.String,
  scope: TranscriptScope,
  kind: Schema.String,
  sessionId: NullableString,
  parentId: NullableString,
  agent: NullableString,
  label: Schema.String,
  detail: Schema.String,
  isError: Schema.Boolean,
}) {}

export class RunDetailView extends Schema.Class<RunDetailView>("@usine/orchestrator/RunDetailView")(
  {
    run: RunView,
    eventDedupKey: Schema.String,
    eventPayload: Schema.Json,
    transcript: Schema.Array(TranscriptEventView),
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
  errorTag: Schema.String,
  projects: Schema.Array(ProjectView),
  loops: Schema.Array(LoopView),
  needsYou: Schema.Array(NeedView),
}) {}

export const FactoryOverview = Schema.Union([ReadyOverview, NeedsSetupOverview]);
export type FactoryOverview = typeof FactoryOverview.Type;
