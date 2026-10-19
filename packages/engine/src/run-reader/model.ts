import { Agent } from "@usine/core/agent";
import { ModelId } from "@usine/core/agent/brain";
import { Attempt, AttemptId, AttemptTask } from "@usine/core/attempt";
import { Event } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { LoopPermissions } from "@usine/core/loop";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { Run } from "@usine/core/run";
import { RunAgain } from "@usine/core/run/again";
import { RunApproval } from "@usine/core/run/approval";
import { Step } from "@usine/core/step";
import { WorkerName } from "@usine/core/worker";
import { Schema } from "effect";
import { TranscriptEntry } from "../transcript.ts";

/** The full durable view of one Run. */
export class RunSnapshot extends Schema.Class<RunSnapshot>("@usine/engine/RunSnapshot")({
  event: Event,
  itemKey: ItemKey,
  run: Run,
  step: Step,
  attempts: Schema.Array(Attempt),
  /** The failed Attempt whose attention the operator resolved; outcomes and history stay intact. */
  resolvedFailureAttemptId: Schema.Option(AttemptId),
  /** The approval the Run consumed; none until one arrives, and always none for a Loop with `approval: none`. */
  approval: Schema.Option(RunApproval),
  /** The closed Run the operator ran again to open this one, and who asked; none for a Run its trigger opened. */
  runAgain: Schema.Option(RunAgain),
  repository: RepositoryName,
  revision: RepositoryRevision,
  task: AttemptTask,
  agent: Agent,
  parentModel: Schema.Option(ModelId),
  /** What the Run's Attempts may do to their repository: the Loop's level when the Run's Event matched. */
  permissions: LoopPermissions,
}) {}

/** A Run snapshot and all its saved transcript entries from the same database transaction. */
export class RunEvidence extends Schema.Class<RunEvidence>("@usine/engine/RunEvidence")({
  snapshot: RunSnapshot,
  transcript: Schema.Array(TranscriptEntry),
}) {}

/** The lighter view used when listing Runs for operators. */
export class RunSummary extends Schema.Class<RunSummary>("@usine/engine/RunSummary")({
  itemKey: ItemKey,
  run: Run,
  step: Step,
  attempts: Schema.Array(Attempt),
  /** The failed Attempt whose attention the operator resolved; outcomes and history stay intact. */
  resolvedFailureAttemptId: Schema.Option(AttemptId),
  /** The approval the Run consumed; none until one arrives, and always none for a Loop with `approval: none`. */
  approval: Schema.Option(RunApproval),
  /** The closed Run the operator ran again to open this one, and who asked; none for a Run its trigger opened. */
  runAgain: Schema.Option(RunAgain),
  repository: RepositoryName,
  task: AttemptTask,
  agent: Agent,
}) {}

/**
 * How many Attempts recorded on one Worker startup reconciliation still
 * visits: every Attempt of that Worker whose leftovers the operator has not
 * discarded.
 */
export class WorkerAttempts extends Schema.Class<WorkerAttempts>("@usine/engine/WorkerAttempts")({
  worker: WorkerName,
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
}) {}

/** Monotonic version of the operator projection. */
export const ProjectionRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand("ProjectionRevision"),
);

export type ProjectionRevision = typeof ProjectionRevision.Type;
