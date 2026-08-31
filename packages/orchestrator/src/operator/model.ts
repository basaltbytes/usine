import { Schema } from "effect";

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

const NullableString = Schema.NullOr(Schema.String);

export class AttemptView extends Schema.Class<AttemptView>("@usine/orchestrator/AttemptView")({
  id: Schema.String,
  number: Schema.Int,
  worker: Schema.String,
  brain: Schema.String,
  startedAt: Schema.String,
  outcome: NullableString,
  errorTag: NullableString,
  errorMessage: NullableString,
}) {}

export class RunView extends Schema.Class<RunView>("@usine/orchestrator/RunView")({
  id: Schema.String,
  loop: Schema.String,
  repository: Schema.String,
  agent: Schema.String,
  state: Schema.String,
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
  repository: Schema.String,
  status: ProjectStatus,
  runs: Schema.Array(RunView),
}) {}

export class LoopView extends Schema.Class<LoopView>("@usine/orchestrator/LoopView")({
  name: Schema.String,
  trigger: Schema.String,
  agent: Schema.String,
  paused: Schema.Boolean,
}) {}

export class NeedView extends Schema.Class<NeedView>("@usine/orchestrator/NeedView")({
  id: Schema.String,
  kind: NeedKind,
  title: Schema.String,
  detail: Schema.String,
  repository: NullableString,
  runId: NullableString,
  loop: NullableString,
}) {}

export class TranscriptEventView extends Schema.Class<TranscriptEventView>(
  "@usine/orchestrator/TranscriptEventView",
)({
  sequence: Schema.Int,
  attemptId: Schema.String,
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
  message: Schema.String,
  errorTag: Schema.String,
  projects: Schema.Array(ProjectView),
  loops: Schema.Array(LoopView),
  needsYou: Schema.Array(NeedView),
}) {}

export const FactoryOverview = Schema.Union([ReadyOverview, NeedsSetupOverview]);
export type FactoryOverview = typeof FactoryOverview.Type;
