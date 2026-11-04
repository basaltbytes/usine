import { CiPolicy } from "@usine/core/ci";
import { Agent, AgentName } from "@usine/core/agent";
import { CycleGeneration, CycleLimit } from "@usine/core/cycle-budget";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import {
  Attempt,
  FailureResolution,
  AttemptNumber,
  AttemptTask,
  AttemptId,
  ContainerOutOfMemoryKills,
  totalOutOfMemoryKills,
} from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AttemptOutcome } from "@usine/core/attempt/outcome";
import { AttemptSalvage } from "@usine/core/attempt/salvage";
import { AttemptStart, OperatorRetryStart } from "@usine/core/attempt/start";
import { Event, DedupKey, EventId } from "@usine/core/event";
import { ApprovalRequirement, LoopName, LoopPermissions } from "@usine/core/loop";
import { ItemKey } from "@usine/core/item";
import { CommitSha, RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { OperatorActor } from "@usine/core/operator";
import { RunId, Run } from "@usine/core/run";
import { RunAgain } from "@usine/core/run/again";
import { ApprovalChannel, ApprovalSource, RunApproval } from "@usine/core/run/approval";
import { StepName, Step } from "@usine/core/step";
import { WorkerName } from "@usine/core/worker";
import * as RunState from "@usine/core/run/state";
import { Comment, StepResult } from "@usine/core/step/result";
import { Array as EffectArray, DateTime, Effect, Option, Schema, Struct } from "effect";
import { EnginePersistenceError, RunStoreError } from "../engine/error.ts";
import { IgnoreReason, Submission } from "../engine/submission.ts";
import { ProjectionRevision, RunEvent, RunSummary, AttemptSummary } from "../run-reader/model.ts";
import { TranscriptEntry, TranscriptSequence } from "../transcript.ts";

export const EventRouteRow = Schema.Struct({
  eventId: EventId,
  dedupKey: DedupKey,
  payload: Schema.Json,
  receivedAt: Schema.DateTimeUtcFromString,
  itemKey: ItemKey,
  loop: LoopName,
  step: StepName,
  approval: ApprovalRequirement,
  approvalReason: Schema.NullOr(Schema.NonEmptyString),
  permissions: LoopPermissions,
  ciPolicy: Schema.NullOr(CiPolicy),
  ciFailureHead: Schema.NullOr(CommitSha),
  ciOnGreen: Submission.fields.ciOnGreen,
  cycleLimit: Schema.NullOr(CycleLimit),
  cycleGeneration: CycleGeneration,
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
  resolvedFailureAttemptId: Schema.NullOr(AttemptId),
  openedAt: Schema.DateTimeUtcFromString,
  closedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  stepName: StepName,
  result: Schema.NullOr(StepResult),
  approvalReason: Schema.NullOr(Schema.NonEmptyString),
  approvedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  approvalChannel: Schema.NullOr(ApprovalChannel),
  approver: Schema.NullOr(OperatorActor),
  againFrom: Schema.NullOr(RunId),
  againRequestedBy: Schema.NullOr(OperatorActor),
});
export type RunRow = typeof RunRow.Type;

export const AttemptRow = Schema.Struct({
  attemptId: AttemptId,
  runId: RunId,
  stepName: StepName,
  worker: WorkerName,
  number: AttemptNumber,
  brain: BrainSpec,
  task: AttemptTask,
  agent: AgentName,
  operatorIntervened: Schema.Boolean,
  parentModel: Schema.NullOr(ModelId),
  startedAt: Schema.DateTimeUtcFromString,
  outcome: Schema.NullOr(AttemptOutcome),
  endedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  salvage: Schema.NullOr(AttemptSalvage),
  start: Schema.NullOr(AttemptStart),
  failureResolution: Schema.NullOr(FailureResolution),
  reattachedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  comments: Schema.NullOr(Schema.Array(Comment)),
  outOfMemory: Schema.NullOr(Schema.Array(ContainerOutOfMemoryKills)),
});
export type AttemptRow = typeof AttemptRow.Type;

export const RunSummaryRow = Schema.Struct({
  ...Struct.omit(RunRow.fields, ["task", "result", "revision", "parentModel", "stepName", "agent"]),
  agent: RunSummary.fields.agent,
  pullRequestUrl: Schema.NullOr(Schema.String),
});
export type RunSummaryRow = typeof RunSummaryRow.Type;

export const AttemptSummaryRow = Schema.Struct(
  Struct.omit(AttemptRow.fields, ["task", "comments"]),
);
export type AttemptSummaryRow = typeof AttemptSummaryRow.Type;
export const decodeRunSummaryRows = Schema.decodeUnknownEffect(Schema.Array(RunSummaryRow));
export const decodeAttemptSummaryRows = Schema.decodeUnknownEffect(Schema.Array(AttemptSummaryRow));

export const TranscriptRow = Schema.Struct({
  sequence: TranscriptSequence,
  attemptId: AttemptId,
  direction: AttemptChannel.Direction,
  envelope: TranscriptEntry.fields.envelope,
  receivedAt: Schema.DateTimeUtcFromString,
});
export type TranscriptRow = typeof TranscriptRow.Type;

const RunIdRow = Schema.Struct({ runId: RunId });
const DiscardRow = Schema.Struct({ reason: IgnoreReason });

const ProjectionRevisionRow = Schema.Struct({ revision: ProjectionRevision });

const RunEventRow = Schema.Struct({
  runId: RunId,
  eventId: EventId,
  dedupKey: DedupKey,
  payload: Schema.Json,
  receivedAt: Schema.DateTimeUtcFromString,
});

const ReopeningRow = Schema.Struct({ ...EventRouteRow.fields, reopening: Schema.Int });
const ReopenedEventRow = Schema.Struct({ eventId: EventId, dedupKey: DedupKey });

export const decodeEventRoutes = Schema.decodeUnknownEffect(Schema.Array(EventRouteRow));
export const decodeReopenings = Schema.decodeUnknownEffect(Schema.Array(ReopeningRow));
export const decodeReopenedEvents = Schema.decodeUnknownEffect(Schema.Array(ReopenedEventRow));
export const decodeRunRows = Schema.decodeUnknownEffect(Schema.Array(RunRow));
export const decodeRunEventRows = Schema.decodeUnknownEffect(Schema.Array(RunEventRow));
export const decodeAttemptRows = Schema.decodeUnknownEffect(Schema.Array(AttemptRow));
export const decodeRunIds = Schema.decodeUnknownEffect(Schema.Array(RunIdRow));
export const decodeDiscards = Schema.decodeUnknownEffect(Schema.Array(DiscardRow));
export const decodeProjectionRevision = Schema.decodeUnknownEffect(
  Schema.Array(ProjectionRevisionRow),
);
export const decodeTranscriptRows = Schema.decodeUnknownEffect(Schema.Array(TranscriptRow));

export const encodePayload = Schema.encodeEffect(Schema.Json);
export const encodeDateTime = DateTime.formatIso;
export const encodeRunState = Schema.encodeEffect(RunState.RunState);
export const encodeOutcome = Schema.encodeEffect(AttemptOutcome);
export const encodeSalvage = Schema.encodeEffect(AttemptSalvage);
export const encodeComments = Schema.encodeEffect(Schema.Array(Comment));
export const encodeOutOfMemory = Schema.encodeEffect(Schema.Array(ContainerOutOfMemoryKills));
export const decodeOutOfMemory = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({ outOfMemory: Schema.NullOr(Schema.Array(ContainerOutOfMemoryKills)) }),
  ),
);
export const encodeFailureResolution = Schema.encodeEffect(FailureResolution);
export const encodeAttemptStart = Schema.encodeEffect(AttemptStart);
export const decodeNextStarts = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ nextStart: Schema.NullOr(OperatorRetryStart) })),
);
export const encodeStepResult = Schema.encodeEffect(StepResult);
export const encodeEnvelope = Schema.encodeEffect(AttemptChannel.Envelope);
export const encodeAgent = Schema.encodeEffect(Agent);
export const encodeBrainSpec = Schema.encodeEffect(BrainSpec);

const isRunStoreError = Schema.is(RunStoreError);

export const persistence =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, RunStoreError, R> =>
    Effect.mapError(effect, (error) =>
      isRunStoreError(error) ? error : EnginePersistenceError.make({ operation, cause: error }),
    );

/** The Event columns shared by route rows and Run Event rows. */
type EventColumns = Pick<EventRouteRow, "eventId" | "dedupKey" | "payload" | "receivedAt">;

export const eventFromRow = (row: EventColumns): Event =>
  Event.make({
    id: row.eventId,
    dedupKey: row.dedupKey,
    payload: row.payload,
    receivedAt: row.receivedAt,
  });

export const runEventFromRow = (row: typeof RunEventRow.Type): RunEvent =>
  RunEvent.make({ runId: row.runId, event: eventFromRow(row) });

export const submissionFromRow = (row: EventRouteRow): Submission =>
  Submission.make({
    event: eventFromRow(row),
    itemKey: row.itemKey,
    loop: row.loop,
    step: row.step,
    approval: row.approval,
    approvalReason: Option.fromNullishOr(row.approvalReason),
    permissions: row.permissions,
    ciPolicy: Option.fromNullishOr(row.ciPolicy),
    ciFailureHead: Option.fromNullishOr(row.ciFailureHead),
    ciOnGreen: row.ciOnGreen,
    cycleLimit: Option.fromNullishOr(row.cycleLimit),
    cycleGeneration: row.cycleGeneration,
    repository: row.repository,
    revision: row.revision,
    task: row.task,
    agent: row.agent,
    parentModel: Option.fromNullishOr(row.parentModel),
  });

export const runFromRow = (
  row: Pick<RunRow, "runId" | "eventId" | "loop" | "state" | "openedAt">,
): Run =>
  Run.make({
    id: row.runId,
    eventId: row.eventId,
    loop: row.loop,
    state: row.state,
    openedAt: row.openedAt,
  });

export const approvalFromRow = (
  row: Pick<RunRow, "approvedAt" | "approvalChannel" | "approver">,
): Option.Option<RunApproval> =>
  Option.map(Option.fromNullishOr(row.approvedAt), (approvedAt) =>
    RunApproval.make({
      approvedAt,
      source: Option.map(Option.fromNullishOr(row.approvalChannel), (channel) =>
        ApprovalSource.make({ channel, approver: Option.fromNullishOr(row.approver) }),
      ),
    }),
  );

export const runAgainFromRow = (
  row: Pick<RunRow, "againFrom" | "againRequestedBy">,
): Option.Option<RunAgain> =>
  Option.map(Option.fromNullishOr(row.againFrom), (from) =>
    RunAgain.make({ from, requestedBy: Option.fromNullishOr(row.againRequestedBy) }),
  );

export const stepFromRow = (row: RunRow): Step =>
  Step.make({
    runId: row.runId,
    name: row.stepName,
    result: Option.fromNullishOr(row.result),
  });

const attemptSummaryFromRow = (row: AttemptSummaryRow): AttemptSummary =>
  AttemptSummary.make({
    id: row.attemptId,
    runId: row.runId,
    stepName: row.stepName,
    worker: row.worker,
    number: row.number,
    brain: row.brain,
    agent: row.agent,
    operatorIntervened: row.operatorIntervened,
    parentModel: Option.fromNullishOr(row.parentModel),
    startedAt: row.startedAt,
    outcome: Option.fromNullishOr(row.outcome),
    endedAt: Option.fromNullishOr(row.endedAt),
    salvage: Option.fromNullishOr(row.salvage),
    start: Option.fromNullishOr(row.start),
    failureResolution: Option.fromNullishOr(row.failureResolution),
    reattachedAt: Option.fromNullishOr(row.reattachedAt),
    outOfMemory: Option.liftPredicate(
      row.outOfMemory ?? [],
      EffectArray.isReadonlyArrayNonEmpty,
    ).pipe(Option.map(totalOutOfMemoryKills)),
  });

export const attemptFromRow = (row: AttemptRow): Attempt =>
  Attempt.make({ ...attemptSummaryFromRow(row), task: row.task, comments: row.comments ?? [] });

export const runSummaryFromRow = (
  row: RunSummaryRow,
  storedAttempts: ReadonlyArray<AttemptSummaryRow>,
): RunSummary =>
  RunSummary.make({
    itemKey: row.itemKey,
    run: runFromRow(row),
    pullRequestUrl: row.pullRequestUrl,
    attempts: storedAttempts.map(attemptSummaryFromRow),
    resolvedFailureAttemptId: Option.fromNullishOr(row.resolvedFailureAttemptId),
    closedAt: Option.fromNullishOr(row.closedAt),
    approval: approvalFromRow(row),
    approvalReason: Option.fromNullishOr(row.approvalReason),
    runAgain: runAgainFromRow(row),
    repository: row.repository,
    agent: row.agent,
  });

export const transcriptEntryFromRow = (row: TranscriptRow): TranscriptEntry =>
  TranscriptEntry.make({
    sequence: row.sequence,
    attemptId: row.attemptId,
    direction: row.direction,
    envelope: row.envelope,
    receivedAt: row.receivedAt,
  });
