import {
  Attempt,
  AttemptChannel,
  Event,
  Item,
  Loop,
  Repository,
  Run,
  RunState,
  Step,
  StepResult,
  Worker,
} from "@usine/core";
import { Effect, Option, Schema } from "effect";
import {
  ApprovalRequirement,
  EnginePersistenceError,
  IgnoreReason,
  RunEngineError,
  Submission,
  TranscriptDirection,
  TranscriptEntry,
  TranscriptSequence,
  WorkflowCommand,
} from "../model.ts";

export const EventRouteRow = Schema.Struct({
  eventId: Event.EventId,
  dedupKey: Event.DedupKey,
  payload: Schema.Json,
  receivedAt: Schema.DateTimeUtcFromString,
  itemKey: Item.ItemKey,
  loop: Loop.LoopName,
  step: Step.StepName,
  approval: ApprovalRequirement,
  repository: Repository.Name,
  revision: Repository.Revision,
  task: AttemptChannel.Task,
});
export type EventRouteRow = typeof EventRouteRow.Type;

export const RunRow = Schema.Struct({
  runId: Run.RunId,
  eventId: Event.EventId,
  loop: Loop.LoopName,
  state: RunState.RunState,
  openedAt: Schema.DateTimeUtcFromString,
  stepName: Step.StepName,
  result: Schema.NullOr(StepResult.StepResult),
});
export type RunRow = typeof RunRow.Type;

export const AttemptRow = Schema.Struct({
  attemptId: Attempt.AttemptId,
  runId: Run.RunId,
  stepName: Step.StepName,
  worker: Worker.Name,
  number: Attempt.AttemptNumber,
  startedAt: Schema.DateTimeUtcFromString,
  outcome: Schema.NullOr(Attempt.Outcome),
});
export type AttemptRow = typeof AttemptRow.Type;

export const TranscriptRow = Schema.Struct({
  sequence: TranscriptSequence,
  attemptId: Attempt.AttemptId,
  direction: TranscriptDirection,
  envelope: AttemptChannel.Envelope,
  receivedAt: Schema.DateTimeUtcFromString,
});
export type TranscriptRow = typeof TranscriptRow.Type;

const RecoverableRunRow = Schema.Struct({
  ...EventRouteRow.fields,
  runId: Run.RunId,
  state: RunState.RunState,
});

const RunIdRow = Schema.Struct({ runId: Run.RunId });
const DiscardRow = Schema.Struct({ reason: IgnoreReason });
export const WorkflowCommandRow = Schema.Struct({
  runId: Run.RunId,
  command: WorkflowCommand,
});
export type WorkflowCommandRow = typeof WorkflowCommandRow.Type;

export const decodeEventRoutes = Schema.decodeUnknownEffect(Schema.Array(EventRouteRow));
export const decodeRunRows = Schema.decodeUnknownEffect(Schema.Array(RunRow));
export const decodeAttemptRows = Schema.decodeUnknownEffect(Schema.Array(AttemptRow));
export const decodeRecoverableRuns = Schema.decodeUnknownEffect(Schema.Array(RecoverableRunRow));
export const decodeRunIds = Schema.decodeUnknownEffect(Schema.Array(RunIdRow));
export const decodeDiscards = Schema.decodeUnknownEffect(Schema.Array(DiscardRow));
export const decodeWorkflowCommands = Schema.decodeUnknownEffect(Schema.Array(WorkflowCommandRow));
export const decodeTranscriptRows = Schema.decodeUnknownEffect(Schema.Array(TranscriptRow));

export const encodePayload = Schema.encodeSync(Schema.Json);
export const encodeDateTime = Schema.encodeSync(Schema.DateTimeUtcFromString);
export const encodeRunState = Schema.encodeSync(RunState.RunState);
export const encodeOutcome = Schema.encodeSync(Attempt.Outcome);
export const encodeStepResult = Schema.encodeSync(StepResult.StepResult);
export const encodeEnvelope = Schema.encodeSync(AttemptChannel.Envelope);

const isRunEngineError = Schema.is(RunEngineError);

export const persistence =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, RunEngineError, R> =>
    Effect.mapError(effect, (error) =>
      isRunEngineError(error) ? error : new EnginePersistenceError({ operation, cause: error }),
    );

export const eventFromRow = (row: EventRouteRow): Event.Event =>
  new Event.Event({
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
  });

export const runFromRow = (row: RunRow): Run.Run =>
  new Run.Run({
    id: row.runId,
    eventId: row.eventId,
    loop: row.loop,
    state: row.state,
    openedAt: row.openedAt,
  });

export const stepFromRow = (row: RunRow): Step.Step =>
  new Step.Step({
    runId: row.runId,
    name: row.stepName,
    result: Option.fromNullishOr(row.result),
  });

export const attemptFromRow = (row: AttemptRow): Attempt.Attempt =>
  new Attempt.Attempt({
    id: row.attemptId,
    runId: row.runId,
    stepName: row.stepName,
    worker: row.worker,
    number: row.number,
    startedAt: row.startedAt,
    outcome: Option.fromNullishOr(row.outcome),
  });

export const transcriptEntryFromRow = (row: TranscriptRow): TranscriptEntry =>
  new TranscriptEntry({
    sequence: row.sequence,
    attemptId: row.attemptId,
    direction: row.direction,
    envelope: row.envelope,
    receivedAt: row.receivedAt,
  });
