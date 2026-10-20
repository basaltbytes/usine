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
    // The Loop's permission level when the Event matched; every Attempt of its Run uses it.
    permissions: text({ enum: LOOP_PERMISSIONS })
      .$type<LoopPermissions>()
      .notNull()
      .default("write"),
    cycleLimit: integer().$type<CycleLimit>(),
    // Item allowance observed before fetching this Event's trigger input.
    cycleGeneration: integer().notNull().default(0),
    // The execution context as submitted, part of the immutable Event fact. A
    // queued Event is claimed later from these columns, while execution reads
    // the Run's own copy below.
    repository: text().$type<RepositoryName>().notNull(),
    revision: text().$type<RepositoryRevision>().notNull(),
    task: text().$type<AttemptTask>().notNull(),
    agentJson: text({ mode: "json" }).$type<unknown>().notNull(),
    parentModel: text().$type<ModelId>(),
    // Set when the engine opened this Event again for the Event a trigger
    // submitted, after that Event's Run was canceled (#267).
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
 * What each Loop last saw of an Item: the Event a trigger last submitted for it,
 * or none after a sighting that did not match. A Run whose Attempt asked the
 * operator a question or reported a blocker holds the Loop on the Item (#241,
 * #341); `heldEventId` is the Item's state after that stop, which opens no Run
 * either.
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
    // The Run's effective context, seeded from the claiming submission.
    // Edit-and-retry amends these columns; the Event columns never change (ADR 0018).
    repository: text().$type<RepositoryName>().notNull(),
    revision: text().$type<RepositoryRevision>().notNull(),
    task: text().$type<AttemptTask>().notNull(),
    agentJson: text({ mode: "json" }).$type<unknown>().notNull(),
    parentModel: text().$type<ModelId>(),
    /** The operator retry that begins the Run's next Attempt; cleared once that Attempt begins. */
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
    /** When the outcome was recorded; null while in flight and for Attempts closed before this column existed. */
    endedAt: text(),
    salvageJson: text({ mode: "json" }).$type<unknown>(),
    /** When the operator discarded what the Attempt left on a Worker that is no longer configured; startup reconciliation skips it from then on. */
    leftoversDiscardedAt: text(),
    /** Why the Attempt began; null for later Attempts begun before this column existed. */
    startJson: text({ mode: "json" }).$type<unknown>(),
    /** When an orchestrator restart last reattached the Attempt; null if none did. */
    reattachedAt: text(),
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
 * The approval Event each approved Run consumed, with its source. Approvals
 * recorded before sources were stored have neither `channel` nor `approver`; a
 * UI approval while `usine.yaml` names no operator has a channel and no approver.
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
 * The Events the operator recorded by running a closed Run again (#152): the
 * Run it ran again and the operator login that asked, none while `usine.yaml`
 * names no operator. The Event's own row says when.
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

/** Cursors that only save work; each owner validates its own value. */
export const cursors = snakeCase.table(
  "usine_cursors",
  {
    cursorKey: text().primaryKey(),
    valueJson: text({ mode: "json" }).$type<unknown>().notNull(),
  },
  (table) => [check("usine_cursors_value_json_valid", sql`json_valid(${table.valueJson})`)],
);

/**
 * The latest payload seen for each Item, for operator reads, and when a poll
 * found that GitHub no longer has the Item.
 */
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

/** The label swaps of the operator's Board moves, each recorded before the factory sends it to GitHub. */
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

/** Operator-owned runtime toggles, kept apart from authored loop files (ADR 0009). */
export const loopRuntime = snakeCase.table("usine_loop_runtime", {
  loopName: text().$type<LoopName>().primaryKey(),
  paused: integer({ mode: "boolean" }).notNull(),
});

/** Single row whose version invalidates cached operator projections. */
export const projectionRevision = snakeCase.table(
  "usine_projection_revision",
  {
    singleton: integer({ mode: "number" }).primaryKey().default(1),
    revision: integer({ mode: "number" }).notNull().default(0),
  },
  (table) => [check("usine_projection_revision_singleton", sql`${table.singleton} = 1`)],
);
