import {
  Attempt,
  AttemptChannel,
  Event,
  Item,
  Loop,
  Repository,
  Run,
  Step,
  Worker,
} from "@usine/core";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  snakeCase,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import {
  APPROVAL_REQUIREMENTS,
  IGNORED_REASONS,
  WORKFLOW_COMMANDS,
  TRANSCRIPT_DIRECTIONS,
  type ApprovalRequirement,
  type IgnoreReason,
  type WorkflowCommand,
} from "../model.ts";

export const events = snakeCase.table(
  "usine_events",
  {
    eventId: text().$type<Event.EventId>().primaryKey(),
    dedupKey: text().$type<Event.DedupKey>().notNull().unique(),
    payloadJson: text({ mode: "json" }).$type<unknown>().notNull(),
    receivedAt: text().notNull(),
  },
  (table) => [check("usine_events_payload_json_valid", sql`json_valid(${table.payloadJson})`)],
);

export const triggerEvents = snakeCase.table(
  "usine_trigger_events",
  {
    eventId: text()
      .$type<Event.EventId>()
      .primaryKey()
      .references(() => events.eventId),
    itemKey: text().$type<Item.ItemKey>().notNull(),
    loopName: text().$type<Loop.LoopName>().notNull(),
    stepName: text().$type<Step.StepName>().notNull(),
    approval: text({ enum: APPROVAL_REQUIREMENTS }).$type<ApprovalRequirement>().notNull(),
    repository: text()
      .$type<Repository.Name>()
      .notNull()
      .default(Repository.Name.make("unknown/unknown")),
    revision: text()
      .$type<Repository.Revision>()
      .notNull()
      .default(Repository.Revision.make("HEAD")),
    task: text()
      .$type<AttemptChannel.Task>()
      .notNull()
      .default(AttemptChannel.Task.make("Migrated run context unavailable")),
  },
  (table) => [
    check("usine_trigger_events_approval", sql`${table.approval} in ('none', 'required')`),
    index("usine_trigger_events_item").on(table.loopName, table.itemKey),
  ],
);

export const runs = snakeCase.table(
  "usine_runs",
  {
    runId: text().$type<Run.RunId>().primaryKey(),
    eventId: text()
      .$type<Event.EventId>()
      .notNull()
      .unique()
      .references(() => triggerEvents.eventId),
    loopName: text().$type<Loop.LoopName>().notNull(),
    stateJson: text({ mode: "json" }).$type<unknown>().notNull(),
    openedAt: text().notNull(),
  },
  (table) => [check("usine_runs_state_json_valid", sql`json_valid(${table.stateJson})`)],
);

export const steps = snakeCase.table(
  "usine_steps",
  {
    runId: text()
      .$type<Run.RunId>()
      .notNull()
      .references(() => runs.runId),
    stepName: text().$type<Step.StepName>().notNull(),
    result: text({ mode: "json" }).$type<unknown>(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.stepName] }),
    check(
      "usine_steps_result_json_valid",
      sql`${table.result} is null or json_valid(${table.result})`,
    ),
  ],
);

export const attempts = snakeCase.table(
  "usine_attempts",
  {
    attemptId: text().$type<Attempt.AttemptId>().primaryKey(),
    runId: text().$type<Run.RunId>().notNull(),
    stepName: text().$type<Step.StepName>().notNull(),
    workerName: text().$type<Worker.Name>().notNull().default(Worker.Name.make("local")),
    attemptNumber: integer({ mode: "number" }).$type<Attempt.AttemptNumber>().notNull(),
    startedAt: text().notNull(),
    outcomeJson: text({ mode: "json" }).$type<unknown>(),
  },
  (table) => [
    check("usine_attempts_number", sql`${table.attemptNumber} >= 1`),
    check(
      "usine_attempts_outcome_json_valid",
      sql`${table.outcomeJson} is null or json_valid(${table.outcomeJson})`,
    ),
    uniqueIndex("usine_attempt_number").on(table.runId, table.stepName, table.attemptNumber),
    uniqueIndex("usine_one_in_flight_attempt")
      .on(table.runId)
      .where(sql`${table.outcomeJson} is null`),
    foreignKey({
      columns: [table.runId, table.stepName],
      foreignColumns: [steps.runId, steps.stepName],
    }),
  ],
);

export const attemptTranscripts = snakeCase.table(
  "usine_attempt_transcripts",
  {
    sequence: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
    attemptId: text()
      .$type<Attempt.AttemptId>()
      .notNull()
      .references(() => attempts.attemptId),
    direction: text({ enum: TRANSCRIPT_DIRECTIONS }).notNull(),
    channelSequence: integer({ mode: "number" }).$type<AttemptChannel.Sequence>().notNull(),
    envelope: text({ mode: "json" }).$type<unknown>().notNull(),
    receivedAt: text().notNull(),
  },
  (table) => [
    check(
      "usine_attempt_transcripts_direction",
      sql`${table.direction} in ('inbound', 'outbound')`,
    ),
    check("usine_attempt_transcripts_sequence", sql`${table.channelSequence} >= 1`),
    check("usine_attempt_transcripts_envelope_json_valid", sql`json_valid(${table.envelope})`),
    uniqueIndex("usine_attempt_transcript_envelope").on(
      table.attemptId,
      table.direction,
      table.channelSequence,
    ),
    index("usine_attempt_transcript_tail").on(table.attemptId, table.sequence),
  ],
);

export const approvals = snakeCase.table("usine_approvals", {
  runId: text()
    .$type<Run.RunId>()
    .primaryKey()
    .references(() => runs.runId),
  eventId: text()
    .$type<Event.EventId>()
    .notNull()
    .unique()
    .references(() => events.eventId),
});

export const ignoredEvents = snakeCase.table(
  "usine_ignored_events",
  {
    eventId: text()
      .$type<Event.EventId>()
      .primaryKey()
      .references(() => triggerEvents.eventId),
    reason: text({ enum: IGNORED_REASONS }).$type<IgnoreReason>().notNull(),
  },
  (table) => [
    check("usine_ignored_events_reason", sql`${table.reason} in ('superseded', 'revoked')`),
  ],
);

export const workflowCommands = snakeCase.table(
  "usine_workflow_commands",
  {
    runId: text()
      .$type<Run.RunId>()
      .notNull()
      .references(() => runs.runId),
    command: text({ enum: WORKFLOW_COMMANDS }).$type<WorkflowCommand>().notNull(),
  },
  (table) => [
    check(
      "usine_workflow_commands_command",
      sql`${table.command} in ('Approve', 'Continue', 'Interrupt', 'Resume')`,
    ),
    primaryKey({ columns: [table.runId, table.command] }),
  ],
);
