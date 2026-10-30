import { ProjectId } from "@usine/core/project";
import { AgentName } from "@usine/core/agent";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { Effect, Schema } from "effect";
import { LabelPreflightFinding } from "../label-reconciler.ts";
import { RunView } from "./run.ts";
import { BoardView, LabelView } from "./board.ts";
import { NeedView } from "./need.ts";

/** The Project's summary status: clear, active, or needs operator attention. */
export const ProjectStatus = Schema.Literals(["clear", "active", "needs-you"]);
/** The project's summary status: clear, active, or needs operator attention. */
export type ProjectStatus = typeof ProjectStatus.Type;

/** A project with its runs, board, label catalog, and preflight findings. */
export class ProjectView extends Schema.Class<ProjectView>("@usine/orchestrator/ProjectView")({
  /** The configured project ID; omitted in repository-only projections. */
  id: Schema.optionalKey(ProjectId),
  /** The configured project display name; omitted in repository-only projections. */
  name: Schema.optionalKey(Schema.String),
  /** Member repositories in configured order; defaults to an empty list for older projections. */
  repositories: Schema.Array(RepositoryName).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
    Schema.withConstructorDefault(Effect.succeed([])),
  ),
  /** First member repository, retained for repository-scoped clients. */
  repository: RepositoryName,
  /** Whether the project needs attention, has active runs, or is clear. */
  status: ProjectStatus,
  /** The project runs included in the overview, newest first. */
  runs: Schema.Array(RunView),
  /** The task cards grouped into the project lanes. */
  board: BoardView,
  /** The repository's label catalog, used to color badges on cards and lanes. */
  labels: Schema.Array(LabelView),
  /** Failures from creating this Project's declared labels, which don't block the Board. */
  preflightFindings: Schema.Array(LabelPreflightFinding),
}) {}

/** A Loop's trigger and Agent with its runtime pause state. */
export class LoopView extends Schema.Class<LoopView>("@usine/orchestrator/LoopView")({
  /** The project-qualified loop name. */
  name: LoopName,
  /** The trigger stream: `issue`, `pr`, or `schedule`. */
  trigger: Schema.String,
  /** The referenced agent name. */
  agent: AgentName,
  /** Whether the loop is paused for new trigger submissions. */
  paused: Schema.Boolean,
}) {}

/** The Projects, Loops, and operator needs of a configured factory. */
export class ReadyOverview extends Schema.TaggedClass<ReadyOverview>(
  "@usine/orchestrator/ReadyOverview",
)("Ready", {
  /** The configured projects with their boards and run summaries. */
  projects: Schema.Array(ProjectView),
  /** Loaded loops with their current pause state. */
  loops: Schema.Array(LoopView),
  /** Unacknowledged entries that need operator attention. */
  needsYou: Schema.Array(NeedView),
  /** Attention entries acknowledged for their displayed revision. */
  dismissedNeeds: Schema.Array(NeedView).pipe(Schema.withConstructorDefault(Effect.succeed([]))),
}) {}

/** The overview during setup, with the error that prevents normal operation. */
export class NeedsSetupOverview extends Schema.TaggedClass<NeedsSetupOverview>(
  "@usine/orchestrator/NeedsSetupOverview",
)("NeedsSetup", {
  /** The setup failure tag. */
  errorTag: Schema.NonEmptyString,
  /** The projects available from stored configuration while setup is incomplete. */
  projects: Schema.Array(ProjectView),
  /** The loaded loops available while setup is incomplete. */
  loops: Schema.Array(LoopView),
  /** The unacknowledged attention entries available while setup is incomplete. */
  needsYou: Schema.Array(NeedView),
  /** The acknowledged attention entries available while setup is incomplete. */
  dismissedNeeds: Schema.Array(NeedView).pipe(Schema.withConstructorDefault(Effect.succeed([]))),
}) {}

/** The operator overview, depending on whether factory setup is complete. */
export const FactoryOverview = Schema.Union([ReadyOverview, NeedsSetupOverview]);
/** The operator overview, depending on whether factory setup is complete. */
export type FactoryOverview = typeof FactoryOverview.Type;
