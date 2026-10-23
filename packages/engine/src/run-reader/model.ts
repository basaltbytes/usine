import { Agent } from "@usine/core/agent";
import { ModelId } from "@usine/core/agent/brain";
import { Attempt, AttemptId, AttemptTask } from "@usine/core/attempt";
import { Event, EventId } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { LoopName, LoopPermissions } from "@usine/core/loop";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { Run, RunId } from "@usine/core/run";
import { RunAgain } from "@usine/core/run/again";
import { RunApproval } from "@usine/core/run/approval";
import { Step } from "@usine/core/step";
import { WorkerName } from "@usine/core/worker";
import { Schema } from "effect";
import { TranscriptEntry } from "../transcript.ts";

/** The full durable view of a Run. */
export class RunSnapshot extends Schema.Class<RunSnapshot>("@usine/engine/RunSnapshot")({
  event: Event,
  itemKey: ItemKey,
  run: Run,
  step: Step,
  attempts: Schema.Array(Attempt),
  /** The failed Attempt that the operator marked as resolved; its outcome is unchanged. */
  resolvedFailureAttemptId: Schema.Option(AttemptId),
  /**
   * The time the Run last closed, or `None` while open. For older Runs, the last Attempt's end or
   * start, or the Run's open time.
   */
  closedAt: Schema.Option(Schema.DateTimeUtc),
  /** The approval the Run consumed, or `None` before approval and for Loops with `approval: none`. */
  approval: Schema.Option(RunApproval),
  /** The run-again origin, or `None` for a Run opened by its trigger. */
  runAgain: Schema.Option(RunAgain),
  repository: RepositoryName,
  revision: RepositoryRevision,
  task: AttemptTask,
  agent: Agent,
  parentModel: Schema.Option(ModelId),
  /** The repository access of the Run's Attempts, from the Loop at match time. */
  permissions: LoopPermissions,
}) {}

/** A Run and the Event it was opened for; the payload is the Item as the trigger saw it. */
export class RunEvent extends Schema.Class<RunEvent>("@usine/engine/RunEvent")({
  runId: RunId,
  event: Event,
}) {}

/** A Run snapshot and all its transcript entries, read in one transaction. */
export class RunEvidence extends Schema.Class<RunEvidence>("@usine/engine/RunEvidence")({
  snapshot: RunSnapshot,
  transcript: Schema.Array(TranscriptEntry),
}) {}

/** The Run view used in operator Run lists. */
export class RunSummary extends Schema.Class<RunSummary>("@usine/engine/RunSummary")({
  itemKey: ItemKey,
  run: Run,
  step: Step,
  attempts: Schema.Array(Attempt),
  /** The failed Attempt that the operator marked as resolved; its outcome is unchanged. */
  resolvedFailureAttemptId: Schema.Option(AttemptId),
  /**
   * The time the Run last closed, or `None` while open. For older Runs, the last Attempt's end or
   * start, or the Run's open time.
   */
  closedAt: Schema.Option(Schema.DateTimeUtc),
  /** The approval the Run consumed, or `None` before approval and for Loops with `approval: none`. */
  approval: Schema.Option(RunApproval),
  /** The run-again origin, or `None` for a Run opened by its trigger. */
  runAgain: Schema.Option(RunAgain),
  repository: RepositoryName,
  task: AttemptTask,
  agent: Agent,
}) {}

/** The number of Attempts on a Worker that startup reconciliation still visits, excluding discarded leftovers. */
export class WorkerAttempts extends Schema.Class<WorkerAttempts>("@usine/engine/WorkerAttempts")(
  Schema.Struct({
    worker: WorkerName,
    attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    /** The number of `attempts` without a recorded outcome. */
    running: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }).check(
    Schema.makeFilter(({ attempts, running }) => running <= attempts, {
      message: "Expected no more open Attempts than Attempts",
    }),
  ),
) {}

/** A Loop's last sighting of an Item and its result (ADR 0007, ADR 0017). */
export class LoopSighting extends Schema.Class<LoopSighting>("@usine/engine/LoopSighting")({
  loop: LoopName,
  itemKey: ItemKey,
  /**
   * The last matching Event, or the newest reopening or run-again Event for it; `None` after a
   * non-matching sighting.
   */
  event: Schema.Option(EventId),
  /** The Run of `event`, or `None` while it waits or after it was ignored. */
  run: Schema.Option(RunId),
  /** The Run that suppresses the Item after a question or blocker, or `None`. */
  suppressedBy: Schema.Option(RunId),
}) {}

/** The monotonic version of the operator projection. */
export const ProjectionRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand("ProjectionRevision"),
);

export type ProjectionRevision = typeof ProjectionRevision.Type;
