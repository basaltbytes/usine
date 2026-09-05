import { Agent } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { Attempt, AttemptNumber, AttemptTask, AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AttemptOutcome } from "@usine/core/attempt/outcome";
import { Event, DedupKey, EventId } from "@usine/core/event";
import { ApprovalRequirement, LoopName } from "@usine/core/loop";
import { ItemKey } from "@usine/core/item";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { RunId, Run } from "@usine/core/run";
import { StepName, Step } from "@usine/core/step";
import { WorkerName } from "@usine/core/worker";
import * as RunState from "@usine/core/run/state";
import { StepResult } from "@usine/core/step/result";
import { Effect, Option, Schema } from "effect";
import { EnginePersistenceError, RunStoreError } from "../engine/error.ts";
import { IgnoreReason, Submission } from "../engine/submission.ts";
import { ProjectionRevision, RunSummary } from "../run-reader/model.ts";
import { TranscriptEntry, TranscriptSequence } from "../transcript.ts";
import { WorkflowCommand } from "../workflow/command.ts";

export const EventRouteRow = Schema.Struct({
  eventId: EventId,
  dedupKey: DedupKey,
  payload: Schema.Json,
  receivedAt: Schema.DateTimeUtcFromString,
  itemKey: ItemKey,
  loop: LoopName,
  step: StepName,
  approval: ApprovalRequirement,
  repository: RepositoryName,
  revision: RepositoryRevision,
  task: AttemptTask,
  agent: Agent,
  parentModel: Schema.NullOr(ModelId),
});
export type EventRouteRow = typeof EventRouteRow.Type;

export const RunRow = Schema.Struct({
  itemKey: ItemKey,
  repository: RepositoryName,
  revision: RepositoryRevision,
  task: AttemptTask,
  agent: Agent,
  parentModel: Schema.NullOr(ModelId),
  runId: RunId,
  eventId: EventId,
  loop: LoopName,
  state: RunState.RunState,
  openedAt: Schema.DateTimeUtcFromString,
  stepName: StepName,
  result: Schema.NullOr(StepResult),
});
export type RunRow = typeof RunRow.Type;

export const AttemptRow = Schema.Struct({
  attemptId: AttemptId,
  runId: RunId,
  stepName: StepName,
  worker: WorkerName,
  number: AttemptNumber,
  brain: BrainSpec,
  parentModel: Schema.NullOr(ModelId),
  startedAt: Schema.DateTimeUtcFromString,
  outcome: Schema.NullOr(AttemptOutcome),
});
export type AttemptRow = typeof AttemptRow.Type;

export const TranscriptRow = Schema.Struct({
  sequence: TranscriptSequence,
  attemptId: AttemptId,
  direction: AttemptChannel.Direction,
  envelope: TranscriptEntry.fields.envelope,
  receivedAt: Schema.DateTimeUtcFromString,
});
export type TranscriptRow = typeof TranscriptRow.Type;

const RecoverableRunRow = Schema.Struct({
  ...EventRouteRow.fields,
  runId: RunId,
  state: RunState.RunState,
});

const RunIdRow = Schema.Struct({ runId: RunId });
const DiscardRow = Schema.Struct({ reason: IgnoreReason });
export const WorkflowCommandRow = Schema.Struct({
  runId: RunId,
  command: WorkflowCommand,
});
export type WorkflowCommandRow = typeof WorkflowCommandRow.Type;

const ProjectionRevisionRow = Schema.Struct({ revision: ProjectionRevision });

export const decodeEventRoutes = Schema.decodeUnknownEffect(Schema.Array(EventRouteRow));
export const decodeRunRows = Schema.decodeUnknownEffect(Schema.Array(RunRow));
export const decodeAttemptRows = Schema.decodeUnknownEffect(Schema.Array(AttemptRow));
export const decodeRecoverableRuns = Schema.decodeUnknownEffect(Schema.Array(RecoverableRunRow));
export const decodeRunIds = Schema.decodeUnknownEffect(Schema.Array(RunIdRow));
export const decodeDiscards = Schema.decodeUnknownEffect(Schema.Array(DiscardRow));
export const decodeWorkflowCommands = Schema.decodeUnknownEffect(Schema.Array(WorkflowCommandRow));
export const decodeProjectionRevision = Schema.decodeUnknownEffect(
  Schema.Array(ProjectionRevisionRow),
);
export const decodeTranscriptRows = Schema.decodeUnknownEffect(Schema.Array(TranscriptRow));

export const encodePayload = Schema.encodeSync(Schema.Json);
export const encodeDateTime = Schema.encodeSync(Schema.DateTimeUtcFromString);
export const encodeRunState = Schema.encodeSync(RunState.RunState);
export const encodeOutcome = Schema.encodeSync(AttemptOutcome);
export const encodeStepResult = Schema.encodeSync(StepResult);
export const encodeEnvelope = Schema.encodeSync(AttemptChannel.Envelope);
export const encodeAgent = Schema.encodeSync(Agent);
export const encodeBrainSpec = Schema.encodeSync(BrainSpec);

const isRunStoreError = Schema.is(RunStoreError);

export const persistence =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, RunStoreError, R> =>
    Effect.mapError(effect, (error) =>
      isRunStoreError(error) ? error : new EnginePersistenceError({ operation, cause: error }),
    );

export const eventFromRow = (row: EventRouteRow): Event =>
  new Event({
    id: row.eventId,
    dedupKey: row.dedupKey,
    payload: row.payload,
    receivedAt: row.receivedAt,
  });

export const submissionFromRow = (row: EventRouteRow): Submission =>
  new Submission({
    event: eventFromRow(row),
    itemKey: row.itemKey,
    loop: row.loop,
    step: row.step,
    approval: row.approval,
    repository: row.repository,
    revision: row.revision,
    task: row.task,
    agent: row.agent,
    parentModel: Option.fromNullishOr(row.parentModel),
  });

export const runFromRow = (row: RunRow): Run =>
  new Run({
    id: row.runId,
    eventId: row.eventId,
    loop: row.loop,
    state: row.state,
    openedAt: row.openedAt,
  });

export const stepFromRow = (row: RunRow): Step =>
  new Step({
    runId: row.runId,
    name: row.stepName,
    result: Option.fromNullishOr(row.result),
  });

export const attemptFromRow = (row: AttemptRow): Attempt =>
  new Attempt({
    id: row.attemptId,
    runId: row.runId,
    stepName: row.stepName,
    worker: row.worker,
    number: row.number,
    brain: row.brain,
    parentModel: Option.fromNullishOr(row.parentModel),
    startedAt: row.startedAt,
    outcome: Option.fromNullishOr(row.outcome),
  });

export const runSummaryFromRow = (
  row: RunRow,
  storedAttempts: ReadonlyArray<AttemptRow>,
): RunSummary =>
  new RunSummary({
    itemKey: row.itemKey,
    run: runFromRow(row),
    step: stepFromRow(row),
    attempts: storedAttempts.map(attemptFromRow),
    repository: row.repository,
    task: row.task,
    agent: row.agent,
  });

export const transcriptEntryFromRow = (row: TranscriptRow): TranscriptEntry =>
  new TranscriptEntry({
    sequence: row.sequence,
    attemptId: row.attemptId,
    direction: row.direction,
    envelope: row.envelope,
    receivedAt: row.receivedAt,
  });
