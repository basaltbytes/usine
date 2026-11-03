import { CiPolicy } from "@usine/core/ci";
import { Agent } from "@usine/core/agent";
import { ModelId } from "@usine/core/agent/brain";
import { Attempt, AttemptId, AttemptTask } from "@usine/core/attempt";
import { Event, EventId } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { LoopName, LoopPermissions } from "@usine/core/loop";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { Run, RunId } from "@usine/core/run";
import { RunState } from "@usine/core/run/state";
import { RunAgain } from "@usine/core/run/again";
import { RunApproval } from "@usine/core/run/approval";
import { Step } from "@usine/core/step";
import { WorkerName } from "@usine/core/worker";
import { Effect, Option, Schema, Struct } from "effect";
import { TranscriptEntry } from "../transcript.ts";

/** The full durable view of a Run. */
export class RunSnapshot extends Schema.Class<RunSnapshot>("@usine/engine/RunSnapshot")({
  /** The event that opened the run, including its saved payload slice. */
  event: Event,
  /** The item identity associated with this run. */
  itemKey: ItemKey,
  /** The saved run identity and lifecycle state. */
  run: Run,
  /** The run's agent action and its result, if an attempt succeeded. */
  step: Step,
  /** All recorded tries of the step, ordered by attempt number. */
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
  /** The saved approval decision, or None for events recorded before decision explanations. */
  approvalReason: Schema.Option(Schema.NonEmptyString).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeedNone),
    Schema.withConstructorDefault(Effect.succeedNone),
  ),
  /** The run-again origin, or `None` for a Run opened by its trigger. */
  runAgain: Schema.Option(RunAgain),
  /** The managed repo checked out for this run. */
  repository: RepositoryName,
  /** The saved repository revision used when preparing attempt checkouts. */
  revision: RepositoryRevision,
  /** The effective task, including the latest edit-and-retry amendment. */
  task: AttemptTask,
  /** The effective agent definition, including the latest edit-and-retry amendment. */
  agent: Agent,
  /** The effective Pi parent model, or `None` to use the runtime default. */
  parentModel: Schema.Option(ModelId),
  /** The repository access of the Run's Attempts, from the Loop at match time. */
  permissions: LoopPermissions,
  /** The loop CI policy saved when the event matched. */
  ciPolicy: Schema.Option(CiPolicy).pipe(Schema.withConstructorDefault(Effect.succeedNone)),
}) {}

/** A Run and the Event it was opened for; the payload is the Item as the trigger saw it. */
export class RunEvent extends Schema.Class<RunEvent>("@usine/engine/RunEvent")({
  /** The run opened for this event. */
  runId: RunId,
  /** The recorded event, including the payload observed when its trigger matched. */
  event: Event,
}) {}

/** A Run snapshot and all its transcript entries, read in one transaction. */
export class RunEvidence extends Schema.Class<RunEvidence>("@usine/engine/RunEvidence")({
  /** The run state and attempt history read in the same transaction as the transcript. */
  snapshot: RunSnapshot,
  /** All entries of the run's attempts, sorted by global transcript append order. */
  transcript: Schema.Array(TranscriptEntry),
}) {}

/** Attempt metadata used by polling reads, without prompts or harvested comments. */
export class AttemptSummary extends Schema.Class<AttemptSummary>("@usine/engine/AttemptSummary")(
  Struct.omit(Attempt.fields, ["task", "comments"]),
) {}

/** The Run view used in operator Run lists. */
export class RunSummary extends Schema.Class<RunSummary>("@usine/engine/RunSummary")({
  /** The item identity associated with this run. */
  itemKey: ItemKey,
  /** The saved run identity and lifecycle state. */
  run: Run,
  /** The first pull request produced by the run, if recorded. */
  pullRequestUrl: Schema.NullOr(Schema.String),
  /** All recorded tries of the step, ordered by attempt number. */
  attempts: Schema.Array(AttemptSummary),
  /** The failed Attempt that the operator marked as resolved; its outcome is unchanged. */
  resolvedFailureAttemptId: Schema.Option(AttemptId),
  /**
   * The time the Run last closed, or `None` while open. For older Runs, the last Attempt's end or
   * start, or the Run's open time.
   */
  closedAt: Schema.Option(Schema.DateTimeUtc),
  /** The approval the Run consumed, or `None` before approval and for Loops with `approval: none`. */
  approval: Schema.Option(RunApproval),
  /** The saved approval decision, or None for events recorded before decision explanations. */
  approvalReason: RunSnapshot.fields.approvalReason,
  /** The run-again origin, or `None` for a Run opened by its trigger. */
  runAgain: Schema.Option(RunAgain),
  /** The managed repo checked out for this run. */
  repository: RepositoryName,
  /** The selected agent’s name and child-session brain. */
  agent: Schema.Struct(Struct.pick(Agent.fields, ["name", "brain"])),
}) {}

/** Builds polling metadata from a snapshot already loaded for a detail read. */
export const summarizeRun = (snapshot: RunSnapshot): RunSummary =>
  RunSummary.make({
    ...snapshot,
    pullRequestUrl: Option.match(snapshot.step.result, {
      onNone: () => null,
      onSome: ({ facts }) =>
        facts.find((fact) => fact._tag === "PullRequest")?.url.toString() ?? null,
    }),
    attempts: snapshot.attempts.map((attempt) => AttemptSummary.make(attempt)),
  });

/** The metadata needed to attribute session usage without reading attempt prompts. */
export class RunUsageSource extends Schema.Class<RunUsageSource>("@usine/engine/RunUsageSource")({
  run: Schema.Struct({ id: RunId }),
  attempts: Schema.Array(Schema.Struct({ id: AttemptId, ended: Schema.Boolean })),
}) {}

/** Historical totals and links for one board item, aggregated in storage. */
export class ItemRunHistory extends Schema.Class<ItemRunHistory>("@usine/engine/ItemRunHistory")({
  itemKey: ItemKey,
  runCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  attemptCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  durationMillis: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  unmeasured: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  runningSince: Schema.Array(Schema.String),
  loops: Schema.Array(
    Schema.Struct({
      loop: LoopName,
      state: RunState,
      firstOpenedAt: Schema.String,
      firstRunId: RunId,
      latestOpenedAt: Schema.String,
      latestRunId: RunId,
    }),
  ),
  pullRequestUrls: Schema.Array(Schema.String),
  usageSources: Schema.Array(RunUsageSource),
}) {}

/** SQL-selected board runs and aggregate history for the selected items. */
export class BoardRunHistory extends Schema.Class<BoardRunHistory>("@usine/engine/BoardRunHistory")(
  {
    runs: Schema.Array(RunSummary),
    items: Schema.Array(ItemRunHistory),
  },
) {}

/** The number of Attempts on a Worker that startup reconciliation still visits, excluding discarded leftovers. */
export class WorkerAttempts extends Schema.Class<WorkerAttempts>("@usine/engine/WorkerAttempts")(
  Schema.Struct({
    /** The configured or removed worker whose attempts still need startup reconciliation. */
    worker: WorkerName,
    /**
     * The total number of tracked attempts on this worker, including those with recorded outcomes.
     */
    attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    /** The number of `attempts` without a recorded outcome. */
    running: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }).check(
    Schema.makeFilter(({ attempts, running }) => running <= attempts, {
      message: "Expected no more open attempts than attempts",
    }),
  ),
) {}

/** A Loop's last sighting of an Item and its result (ADR 0007, ADR 0017). */
export class LoopSighting extends Schema.Class<LoopSighting>("@usine/engine/LoopSighting")({
  /** The qualified loop identity that last evaluated the item. */
  loop: LoopName,
  /** The evaluated item, used with the loop identity to find the last match. */
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
