import { ModelId } from "@usine/core/agent/brain";
import { AgentName } from "@usine/core/agent";
import { AttemptNumber, AttemptTask, AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { DedupKey, EventId } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { CycleLimit, CycleBudgetAskId } from "@usine/core/cycle-budget";
import {
  LoopName,
  APPROVAL_REQUIREMENTS,
  type ApprovalRequirement,
  LOOP_PERMISSIONS,
  type LoopPermissions,
} from "@usine/core/loop";
import { OperatorLogin } from "@usine/core/operator";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { APPROVAL_CHANNELS, type ApprovalChannel } from "@usine/core/run/approval";
import { StepName } from "@usine/core/step";
import { WorkerName } from "@usine/core/worker";
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
import { IGNORED_REASONS, type IgnoreReason } from "../engine/submission.ts";

export const events = snakeCase.table(
  "usine_events",
  {
    eventId: text().$type<EventId>().primaryKey(),
    dedupKey: text().$type<DedupKey>().notNull().unique(),
    payloadJson: text({ mode: "json" }).$type<unknown>().notNull(),
    receivedAt: text().notNull(),
  },
  (table) => [check("usine_events_payload_json_valid", sql`json_valid(${table.payloadJson})`)],
);

export const triggerEvents = snakeCase.table(
  "usine_trigger_events",
  {
    eventId: text()
      .$type<EventId>()
      .primaryKey()
      .references(() => events.eventId),
    itemKey: text().$type<ItemKey>().notNull(),
    loopName: text().$type<LoopName>().notNull(),
    stepName: text().$type<StepName>().notNull(),
    approval: text({ enum: APPROVAL_REQUIREMENTS }).$type<ApprovalRequirement>().notNull(),
    // The Loop's permissions at match time, used by every Attempt of the Run.
    permissions: text({ enum: LOOP_PERMISSIONS })
      .$type<LoopPermissions>()
      .notNull()
      .default("write"),
    cycleLimit: integer().$type<CycleLimit>(),
    // The Item's cycle generation, read before fetching the trigger input.
    cycleGeneration: integer().notNull().default(0),
    // The submitted execution context, never updated. A queued Event is claimed from these
    // columns; execution reads the Run's copy.
    repository: text().$type<RepositoryName>().notNull(),
    revision: text().$type<RepositoryRevision>().notNull(),
    task: text().$type<AttemptTask>().notNull(),
    agentJson: text({ mode: "json" }).$type<unknown>().notNull(),
    parentModel: text().$type<ModelId>(),
    // The Event that this one reopens after its Run was canceled (#267).
    reopensEventId: text()
      .$type<EventId>()
      .references(() => events.eventId),
    reopening: integer().notNull().default(0),
  },
  (table) => [
    check("usine_trigger_events_approval", sql`${table.approval} in ('none', 'required')`),
    check(
      "usine_trigger_events_cycle_limit",
      sql`${table.cycleLimit} is null or ${table.cycleLimit} >= 1`,
    ),
    check("usine_trigger_events_agent_json_valid", sql`json_valid(${table.agentJson})`),
    index("usine_trigger_events_item").on(table.loopName, table.itemKey),
    index("usine_trigger_events_item_history").on(table.itemKey),
    uniqueIndex("usine_trigger_event_reopening").on(table.reopensEventId, table.reopening),
  ],
);

/**
 * The Event a trigger last submitted for each Loop and Item, or `null` after a non-matching
 * sighting. After an Attempt stops with a question or blocker, `heldEventId` is the Item's
 * state after the stop, which opens no Run (#241, #341).
 */
export const loopItems = snakeCase.table(
  "usine_loop_items",
  {
    loopName: text().$type<LoopName>().notNull(),
    itemKey: text().$type<ItemKey>().notNull(),
    observedEventId: text()
      .$type<EventId>()
      .references(() => events.eventId),
    heldByRunId: text()
      .$type<RunId>()
      .references(() => runs.runId),
    heldEventId: text()
      .$type<EventId>()
      .references(() => events.eventId),
  },
  (table) => [primaryKey({ columns: [table.loopName, table.itemKey] })],
);

export const itemCycleBudgets = snakeCase.table(
  "usine_item_cycle_budgets",
  {
    itemKey: text().$type<ItemKey>().primaryKey(),
    repository: text().$type<RepositoryName>().notNull(),
    generation: integer().notNull().default(0),
    askJson: text({ mode: "json" }).$type<unknown>(),
    resetPending: integer({ mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    check("usine_item_cycle_generation", sql`${table.generation} >= 0`),
    check(
      "usine_item_cycle_ask_json",
      sql`${table.askJson} is null or json_valid(${table.askJson})`,
    ),
  ],
);

export const cycleReservations = snakeCase.table(
  "usine_cycle_reservations",
  {
    runId: text()
      .$type<RunId>()
      .primaryKey()
      .references(() => runs.runId),
    itemKey: text()
      .$type<ItemKey>()
      .notNull()
      .references(() => itemCycleBudgets.itemKey),
    generation: integer().notNull(),
    loop: text().$type<LoopName>().notNull(),
  },
  (table) => [
    index("usine_cycle_reservations_item").on(table.itemKey, table.generation, table.loop),
    check("usine_cycle_reservations_generation", sql`${table.generation} >= 0`),
  ],
);

export const cycleResets = snakeCase.table("usine_cycle_resets", {
  askId: text().$type<CycleBudgetAskId>().primaryKey(),
  eventId: text()
    .$type<EventId>()
    .notNull()
    .unique()
    .references(() => events.eventId),
  itemKey: text()
    .$type<ItemKey>()
    .notNull()
    .references(() => itemCycleBudgets.itemKey),
});

export const runs = snakeCase.table(
  "usine_runs",
  {
    runId: text().$type<RunId>().primaryKey(),
    eventId: text()
      .$type<EventId>()
      .notNull()
      .unique()
      .references(() => triggerEvents.eventId),
    loopName: text().$type<LoopName>().notNull(),
    stateJson: text({ mode: "json" }).$type<unknown>().notNull(),
    resolvedFailureAttemptId: text().$type<AttemptId>(),
    openedAt: text().notNull(),
    /**
     * The time the Run last closed, or `null` while open; a retry clears it. Older closed Runs
     * have their last Attempt's end time.
     */
    closedAt: text(),
    // The Run's effective context, copied from the claiming submission. Edit-and-retry updates
    // these columns; the Event's columns never change (ADR 0018).
    repository: text().$type<RepositoryName>().notNull(),
    revision: text().$type<RepositoryRevision>().notNull(),
    task: text().$type<AttemptTask>().notNull(),
    agentJson: text({ mode: "json" }).$type<unknown>().notNull(),
    parentModel: text().$type<ModelId>(),
    /** The operator retry for the Run's next Attempt; cleared when that Attempt starts. */
    nextStartJson: text({ mode: "json" }).$type<unknown>(),
  },
  (table) => [
    check("usine_runs_state_json_valid", sql`json_valid(${table.stateJson})`),
    check("usine_runs_agent_json_valid", sql`json_valid(${table.agentJson})`),
  ],
);

export const steps = snakeCase.table(
  "usine_steps",
  {
    runId: text()
      .$type<RunId>()
      .notNull()
      .references(() => runs.runId),
    stepName: text().$type<StepName>().notNull(),
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
    attemptId: text().$type<AttemptId>().primaryKey(),
    runId: text().$type<RunId>().notNull(),
    stepName: text().$type<StepName>().notNull(),
    workerName: text().$type<WorkerName>().notNull(),
    attemptNumber: integer({ mode: "number" }).$type<AttemptNumber>().notNull(),
    brainJson: text({ mode: "json" }).$type<unknown>().notNull(),
    task: text().$type<AttemptTask>().notNull(),
    agent: text().$type<AgentName>().notNull(),
    operatorIntervened: integer({ mode: "boolean" }).notNull().default(false),
    parentModel: text().$type<ModelId>(),
    startedAt: text().notNull(),
    outcomeJson: text({ mode: "json" }).$type<unknown>(),
    /** The time the outcome was recorded; `null` while running and for older Attempts. */
    endedAt: text(),
    salvageJson: text({ mode: "json" }).$type<unknown>(),
    /** The time the operator discarded the Attempt's leftovers on a removed Worker; startup reconciliation then skips it. */
    leftoversDiscardedAt: text(),
    /** The reason the Attempt started; `null` for older Attempts. */
    startJson: text({ mode: "json" }).$type<unknown>(),
    /** The last time an orchestrator restart reattached the Attempt, or `null`. */
    reattachedAt: text(),
    /** The comments and reviews posted by an unsuccessful Attempt, or `null` if none were recorded. */
    commentsJson: text({ mode: "json" }).$type<unknown>(),
  },
  (table) => [
    check("usine_attempts_number", sql`${table.attemptNumber} >= 1`),
    check("usine_attempts_brain_json_valid", sql`json_valid(${table.brainJson})`),
    check(
      "usine_attempts_outcome_json_valid",
      sql`${table.outcomeJson} is null or json_valid(${table.outcomeJson})`,
    ),
    check(
      "usine_attempts_salvage_json_valid",
      sql`${table.salvageJson} is null or json_valid(${table.salvageJson})`,
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
      .$type<AttemptId>()
      .notNull()
      .references(() => attempts.attemptId),
    direction: text({ enum: AttemptChannel.DIRECTIONS }).notNull(),
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

/**
 * The approval Event each approved Run consumed, with its source. Older rows have no `channel`
 * or `approver`; a UI approval without a configured operator login has no `approver`.
 */
export const approvals = snakeCase.table(
  "usine_approvals",
  {
    runId: text()
      .$type<RunId>()
      .primaryKey()
      .references(() => runs.runId),
    eventId: text()
      .$type<EventId>()
      .notNull()
      .unique()
      .references(() => events.eventId),
    channel: text({ enum: APPROVAL_CHANNELS }).$type<ApprovalChannel>(),
    approver: text().$type<OperatorLogin>(),
  },
  (table) => [
    check(
      "usine_approvals_source",
      sql`(${table.channel} is null and ${table.approver} is null) or ${table.channel} = 'ui' or (${table.channel} = 'github-ask' and ${table.approver} is not null)`,
    ),
  ],
);

/**
 * The Events recorded by running a closed Run again (#152), with the original Run and the
 * requesting login, which is `null` if `usine.yaml` sets no operator login.
 */
export const runAgainEvents = snakeCase.table("usine_run_again_events", {
  eventId: text()
    .$type<EventId>()
    .primaryKey()
    .references(() => triggerEvents.eventId),
  fromRunId: text()
    .$type<RunId>()
    .notNull()
    .references(() => runs.runId),
  requestedBy: text().$type<OperatorLogin>(),
});

export const ignoredEvents = snakeCase.table(
  "usine_ignored_events",
  {
    eventId: text()
      .$type<EventId>()
      .primaryKey()
      .references(() => triggerEvents.eventId),
    reason: text({ enum: IGNORED_REASONS }).$type<IgnoreReason>().notNull(),
  },
  (table) => [
    check("usine_ignored_events_reason", sql`${table.reason} in ('superseded', 'revoked')`),
  ],
);

/** Cursors whose loss only repeats work; each owner validates its value. */
export const cursors = snakeCase.table(
  "usine_cursors",
  {
    cursorKey: text().primaryKey(),
    valueJson: text({ mode: "json" }).$type<unknown>().notNull(),
  },
  (table) => [check("usine_cursors_value_json_valid", sql`json_valid(${table.valueJson})`)],
);

/** The latest payload of each Item, and the time a poll found it missing on GitHub. */
export const itemProjections = snakeCase.table(
  "usine_item_projections",
  {
    itemKey: text().$type<ItemKey>().primaryKey(),
    repository: text().$type<RepositoryName>().notNull(),
    source: text().notNull(),
    itemNumber: integer({ mode: "number" }).notNull(),
    contentHash: text().notNull(),
    payloadJson: text({ mode: "json" }).$type<unknown>().notNull(),
    goneAt: text(),
  },
  (table) => [
    check("usine_item_projections_number", sql`${table.itemNumber} >= 1`),
    check("usine_item_projections_payload_json_valid", sql`json_valid(${table.payloadJson})`),
    uniqueIndex("usine_item_projection_number").on(table.repository, table.itemNumber),
  ],
);

/** The latest complete label catalog for each managed repository. */
export const repositoryLabelProjections = snakeCase.table(
  "usine_repository_label_projections",
  {
    repository: text().$type<RepositoryName>().primaryKey(),
    labelsJson: text({ mode: "json" }).$type<unknown>().notNull(),
  },
  (table) => [
    check(
      "usine_repository_label_projections_labels_json_valid",
      sql`json_valid(${table.labelsJson})`,
    ),
  ],
);

/** The label changes of operator Board moves, each recorded before it's sent to GitHub. */
export const boardMoves = snakeCase.table(
  "usine_board_moves",
  {
    moveId: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
    repository: text().$type<RepositoryName>().notNull(),
    itemKey: text().$type<ItemKey>().notNull(),
    movedAt: text().notNull(),
    fromLane: text().notNull(),
    toLane: text().notNull(),
    addedJson: text({ mode: "json" }).$type<unknown>().notNull(),
    removedJson: text({ mode: "json" }).$type<unknown>().notNull(),
  },
  (table) => [
    check("usine_board_moves_added_json_valid", sql`json_valid(${table.addedJson})`),
    check("usine_board_moves_removed_json_valid", sql`json_valid(${table.removedJson})`),
    index("usine_board_moves_item").on(table.itemKey, table.movedAt),
  ],
);

/** Operator runtime toggles, separate from Loop files (ADR 0009). */
export const loopRuntime = snakeCase.table("usine_loop_runtime", {
  loopName: text().$type<LoopName>().primaryKey(),
  paused: integer({ mode: "boolean" }).notNull(),
});

/** A single row whose version invalidates cached operator projections. */
export const projectionRevision = snakeCase.table(
  "usine_projection_revision",
  {
    singleton: integer({ mode: "number" }).primaryKey().default(1),
    revision: integer({ mode: "number" }).notNull().default(0),
  },
  (table) => [check("usine_projection_revision_singleton", sql`${table.singleton} = 1`)],
);
