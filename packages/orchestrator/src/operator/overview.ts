import { AgentName } from "@usine/core/agent";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { Schema } from "effect";
import { LabelPreflightFinding } from "../label-reconciler.ts";
import { RunView } from "./run.ts";
import { BoardView, LabelView } from "./board.ts";
import { NeedView } from "./need.ts";

/** The Project's summary status: clear, active, or needs operator attention. */
export const ProjectStatus = Schema.Literals(["clear", "active", "needs-you"]);
export type ProjectStatus = typeof ProjectStatus.Type;

/** A managed repository with its Runs, Board, label catalog, and preflight findings. */
export class ProjectView extends Schema.Class<ProjectView>("@usine/orchestrator/ProjectView")({
  repository: RepositoryName,
  status: ProjectStatus,
  runs: Schema.Array(RunView),
  board: BoardView,
  /** The repository's label catalog, used to color badges on cards and lanes. */
  labels: Schema.Array(LabelView),
  /** Failures from creating this Project's declared labels, which don't block the Board. */
  preflightFindings: Schema.Array(LabelPreflightFinding),
}) {}

/** A Loop's trigger and Agent with its runtime pause state. */
export class LoopView extends Schema.Class<LoopView>("@usine/orchestrator/LoopView")({
  name: LoopName,
  trigger: Schema.String,
  agent: AgentName,
  paused: Schema.Boolean,
}) {}

/** The Projects, Loops, and operator needs of a configured factory. */
export class ReadyOverview extends Schema.TaggedClass<ReadyOverview>(
  "@usine/orchestrator/ReadyOverview",
)("Ready", {
  projects: Schema.Array(ProjectView),
  loops: Schema.Array(LoopView),
  needsYou: Schema.Array(NeedView),
}) {}

/** The overview during setup, with the error that prevents normal operation. */
export class NeedsSetupOverview extends Schema.TaggedClass<NeedsSetupOverview>(
  "@usine/orchestrator/NeedsSetupOverview",
)("NeedsSetup", {
  errorTag: Schema.NonEmptyString,
  projects: Schema.Array(ProjectView),
  loops: Schema.Array(LoopView),
  needsYou: Schema.Array(NeedView),
}) {}

/** The operator overview, depending on whether factory setup is complete. */
export const FactoryOverview = Schema.Union([ReadyOverview, NeedsSetupOverview]);
export type FactoryOverview = typeof FactoryOverview.Type;
