import { Attempt, Event, Item, Loop, Run, RunState, Step } from "@usine/core";
import { Effect, Option, Schema } from "effect";
import { Migrator, SqlClient } from "effect/unstable/sql";
import {
  ApprovalRequirement,
  EnginePersistenceError,
  IgnoreReason,
  RunNotFoundError,
  RunOperationRejectedError,
  Submission,
} from "./model.ts";

export const EventRouteRow = Schema.Struct({
  eventId: Event.EventId,
  dedupKey: Event.DedupKey,
  payload: Schema.fromJsonString(Schema.Json),
  receivedAt: Schema.DateTimeUtcFromString,
  itemKey: Item.ItemKey,
  loop: Loop.LoopName,
  step: Step.StepName,
  approval: ApprovalRequirement,
});
export type EventRouteRow = typeof EventRouteRow.Type;

export const RunRow = Schema.Struct({
  runId: Run.RunId,
  eventId: Event.EventId,
  loop: Loop.LoopName,
  state: Schema.fromJsonString(RunState.RunState),
  openedAt: Schema.DateTimeUtcFromString,
  stepName: Step.StepName,
  result: Schema.NullOr(Schema.String),
});
export type RunRow = typeof RunRow.Type;

export const AttemptRow = Schema.Struct({
  attemptId: Attempt.AttemptId,
  runId: Run.RunId,
  stepName: Step.StepName,
  number: Attempt.AttemptNumber,
  startedAt: Schema.DateTimeUtcFromString,
  outcome: Schema.NullOr(Schema.fromJsonString(Attempt.Outcome)),
});
export type AttemptRow = typeof AttemptRow.Type;

const RunIdRow = Schema.Struct({ runId: Run.RunId });
const CountRow = Schema.Struct({ count: Schema.Number });
const DiscardRow = Schema.Struct({ reason: IgnoreReason });
export const WorkflowCommand = Schema.Literals(["Approve", "Continue", "Interrupt", "Resume"]);
export type WorkflowCommand = typeof WorkflowCommand.Type;
const WorkflowCommandRow = Schema.Struct({
  runId: Run.RunId,
  command: WorkflowCommand,
});

export const decodeEventRoutes = Schema.decodeUnknownEffect(Schema.Array(EventRouteRow));
export const decodeRunRows = Schema.decodeUnknownEffect(Schema.Array(RunRow));
export const decodeAttemptRows = Schema.decodeUnknownEffect(Schema.Array(AttemptRow));
export const decodeRunIds = Schema.decodeUnknownEffect(Schema.Array(RunIdRow));
export const decodeCounts = Schema.decodeUnknownEffect(Schema.Array(CountRow));
export const decodeDiscards = Schema.decodeUnknownEffect(Schema.Array(DiscardRow));
export const decodeWorkflowCommands = Schema.decodeUnknownEffect(Schema.Array(WorkflowCommandRow));

export const encodePayload = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
export const encodeDateTime = Schema.encodeSync(Schema.DateTimeUtcFromString);
export const encodeRunState = Schema.encodeSync(Schema.fromJsonString(RunState.RunState));
export const encodeOutcome = Schema.encodeSync(Schema.fromJsonString(Attempt.Outcome));

export const migrations = Migrator.fromRecord({
  "0001_runtime_projection": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE usine_events (
        event_id TEXT PRIMARY KEY,
        dedup_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        received_at TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE usine_trigger_events (
        event_id TEXT PRIMARY KEY REFERENCES usine_events(event_id),
        item_key TEXT NOT NULL,
        loop_name TEXT NOT NULL,
        step_name TEXT NOT NULL,
        approval TEXT NOT NULL CHECK (approval IN ('none', 'required'))
      )
    `;
    yield* sql`
      CREATE TABLE usine_runs (
        run_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE REFERENCES usine_trigger_events(event_id),
        loop_name TEXT NOT NULL,
        state_json TEXT NOT NULL CHECK (json_valid(state_json)),
        opened_at TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE usine_steps (
        run_id TEXT NOT NULL REFERENCES usine_runs(run_id),
        step_name TEXT NOT NULL,
        result TEXT,
        PRIMARY KEY (run_id, step_name)
      )
    `;
    yield* sql`
      CREATE TABLE usine_attempts (
        attempt_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_name TEXT NOT NULL,
        attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
        started_at TEXT NOT NULL,
        outcome_json TEXT CHECK (outcome_json IS NULL OR json_valid(outcome_json)),
        UNIQUE (run_id, step_name, attempt_number),
        FOREIGN KEY (run_id, step_name) REFERENCES usine_steps(run_id, step_name)
      )
    `;
    yield* sql`
      CREATE UNIQUE INDEX usine_one_in_flight_attempt
      ON usine_attempts(run_id)
      WHERE outcome_json IS NULL
    `;
    yield* sql`
      CREATE TABLE usine_approvals (
        run_id TEXT PRIMARY KEY REFERENCES usine_runs(run_id),
        event_id TEXT NOT NULL UNIQUE REFERENCES usine_events(event_id)
      )
    `;
    yield* sql`
      CREATE TABLE usine_ignored_events (
        event_id TEXT PRIMARY KEY REFERENCES usine_trigger_events(event_id),
        reason TEXT NOT NULL CHECK (reason IN ('superseded', 'revoked'))
      )
    `;
    yield* sql`
      CREATE TABLE usine_workflow_commands (
        run_id TEXT NOT NULL REFERENCES usine_runs(run_id),
        command TEXT NOT NULL CHECK (command IN ('Approve', 'Continue', 'Interrupt', 'Resume')),
        PRIMARY KEY (run_id, command)
      )
    `;
    yield* sql`
      CREATE INDEX usine_trigger_events_item
      ON usine_trigger_events(loop_name, item_key)
    `;
  }),
});

const isRunEngineError = Schema.is(
  Schema.Union([RunNotFoundError, RunOperationRejectedError, EnginePersistenceError]),
);

export const persistence =
  (operation: string) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, EnginePersistenceError | RunNotFoundError | RunOperationRejectedError, R> =>
    Effect.mapError(effect, (error) =>
      isRunEngineError(error)
        ? error
        : new EnginePersistenceError({
            operation,
            message: `${operation} failed`,
            cause: error,
          }),
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
    number: row.number,
    startedAt: row.startedAt,
    outcome: Option.fromNullishOr(row.outcome),
  });
