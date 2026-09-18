import { RepositoryName } from "@usine/core/repository";
import { WorkerName } from "@usine/core/worker";
import type { Agent } from "@usine/core/agent";
import type { ModelId } from "@usine/core/agent/brain";
import { Attempt, AttemptId, AttemptContext, AttemptNumber } from "@usine/core/attempt";

import { AttemptOutcome } from "@usine/core/attempt/outcome";
import { AttemptSalvage, salvageRefFor } from "@usine/core/attempt/salvage";
import { Event, DedupKey, EventId } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RunId } from "@usine/core/run";
import { StepName } from "@usine/core/step";
import * as RunState from "@usine/core/run/state";
import { StepResult } from "@usine/core/step/result";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  notInArray,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { Array as EffectArray, DateTime, Effect, Option, Schema } from "effect";
import type { RunDatabaseClient } from "../database/database.ts";
import {
  approvals,
  attempts,
  events,
  ignoredEvents,
  projectionRevision,
  runs,
  steps,
  triggerEvents,
  workflowCommands,
} from "../database/schema.ts";
import { RunNotFoundError } from "../engine/error.ts";
import { RunSnapshot, RunSummary } from "../run-reader/model.ts";
import { Submission } from "../engine/submission.ts";

import { WORKFLOW_COMMAND_PRIORITY, type WorkflowCommand } from "../workflow/command.ts";
import { cycleQueries } from "../cycle-budget/queries.ts";
import {
  type RunRow,
  attemptFromRow,
  decodeAttemptRows,
  decodeDiscards,
  decodeEventRoutes,
  decodeRecoverableRuns,
  decodeProjectionRevision,
  decodeRunIds,
  decodeRunRows,
  decodeWorkflowCommands,
  encodeAgent,
  encodeBrainSpec,
  encodeDateTime,
  encodeOutcome,
  encodeSalvage,
  encodePayload,
  encodeRunState,
  encodeStepResult,
  eventFromRow,
  runFromRow,
  runSummaryFromRow,
  stepFromRow,
  submissionFromRow,
} from "./codec.ts";

import { transcriptQueries } from "./transcript.ts";

/** The newest queued submission and the exact Events observed alongside it. */
export interface QueuedEvents {
  readonly submission: Submission;
  readonly eventIds: ReadonlyArray<EventId>;
}

const newestRunFirst = (left: RunRow, right: RunRow) =>
  DateTime.toEpochMillis(right.openedAt) - DateTime.toEpochMillis(left.openedAt) ||
  right.runId.localeCompare(left.runId);

const eventRouteSelection = {
  eventId: events.eventId,
  dedupKey: events.dedupKey,
  payload: events.payloadJson,
  receivedAt: events.receivedAt,
  itemKey: triggerEvents.itemKey,
  loop: triggerEvents.loopName,
  step: triggerEvents.stepName,
  approval: triggerEvents.approval,
  cycleLimit: triggerEvents.cycleLimit,
  cycleGeneration: triggerEvents.cycleGeneration,
  repository: triggerEvents.repository,
  revision: triggerEvents.revision,
  task: triggerEvents.task,
  agent: triggerEvents.agentJson,
  parentModel: triggerEvents.parentModel,
} as const;

const runSelection = {
  itemKey: triggerEvents.itemKey,
  runId: runs.runId,
  eventId: runs.eventId,
  loop: runs.loopName,
  state: runs.stateJson,
  resolvedFailureAttemptId: runs.resolvedFailureAttemptId,
  openedAt: runs.openedAt,
  repository: runs.repository,
  revision: runs.revision,
  task: runs.task,
  agent: runs.agentJson,
  parentModel: runs.parentModel,
  stepName: steps.stepName,
  result: steps.result,
} as const;

const attemptSelection = {
  attemptId: attempts.attemptId,
  runId: attempts.runId,
  stepName: attempts.stepName,
  worker: attempts.workerName,
  number: attempts.attemptNumber,
  brain: attempts.brainJson,
  task: attempts.task,
  agent: attempts.agent,
  operatorIntervened: attempts.operatorIntervened,
  parentModel: attempts.parentModel,
  startedAt: attempts.startedAt,
  outcome: attempts.outcomeJson,
  salvage: attempts.salvageJson,
} as const;

// The state partitions are owned by @usine/core; these predicates only borrow their tags.
const storedStateTag = sql`json_extract(${runs.stateJson}, '$._tag')`;
const openState = inArray(storedStateTag, [...RunState.OPEN_STATE_TAGS]);
const unstartedState = inArray(storedStateTag, [...RunState.UNSTARTED_STATE_TAGS]);
// The Json round-trip gives `queriesFor` a portable named type; without it tsc
// cannot emit the declaration (TS2883).
const storedAgent = (agent: Agent): Schema.Json =>
  Schema.decodeUnknownSync(Schema.Json)(encodeAgent(agent));

export const queriesFor = (database: RunDatabaseClient) => {
  // Keep `.execute()` explicit: the yieldable wrapper can cross an Effect
  // Workflow suspension before its final mutation is observable (ADR 0020).
  const eventRouteByDedup = Effect.fn("RunStoreQueries.eventRouteByDedup")(function* (
    dedupKey: DedupKey,
  ) {
    const rows = yield* database
      .select(eventRouteSelection)
      .from(events)
      .innerJoin(triggerEvents, eq(triggerEvents.eventId, events.eventId))
      .where(eq(events.dedupKey, dedupKey))
      .execute();
    return yield* decodeEventRoutes(rows);
  });

  const eventRouteByRun = Effect.fn("RunStoreQueries.eventRouteByRun")(function* (runId: RunId) {
    const rows = yield* database
      .select(eventRouteSelection)
      .from(runs)
      .innerJoin(events, eq(events.eventId, runs.eventId))
      .innerJoin(triggerEvents, eq(triggerEvents.eventId, events.eventId))
      .where(eq(runs.runId, runId))
      .execute();
    return yield* decodeEventRoutes(rows);
  });

  const runRows = Effect.fn("RunStoreQueries.runRows")(function* (runId: RunId) {
    const rows = yield* database
      .select(runSelection)
      .from(runs)
      .innerJoin(triggerEvents, eq(triggerEvents.eventId, runs.eventId))
      .innerJoin(steps, eq(steps.runId, runs.runId))
      .where(eq(runs.runId, runId))
      .execute();
    return yield* decodeRunRows(rows);
  });

  const salvageCandidates = Effect.fn("RunStoreQueries.salvageCandidates")(function* () {
    const rows = yield* database
      .select({
        attemptId: attempts.attemptId,
        worker: attempts.workerName,
        repository: runs.repository,
        runId: attempts.runId,
        number: attempts.attemptNumber,
      })
      .from(attempts)
      .innerJoin(runs, eq(runs.runId, attempts.runId))
      .where(sql`coalesce(json_extract(${attempts.outcomeJson}, '$._tag'), '') != 'Succeeded'`)
      .execute();
    const decoded = yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({
          attemptId: AttemptId,
          worker: WorkerName,
          repository: RepositoryName,
          runId: RunId,
          number: AttemptNumber,
        }),
      ),
    )(rows);
    return decoded.map(({ runId, number, ...attempt }) => ({
      ...attempt,
      ref: salvageRefFor(runId, number),
    }));
  });

  const attemptRows = Effect.fn("RunStoreQueries.attemptRows")(function* (runId: RunId) {
    const rows = yield* database
      .select(attemptSelection)
      .from(attempts)
      .where(eq(attempts.runId, runId))
      .orderBy(attempts.attemptNumber)
      .execute();
    return yield* decodeAttemptRows(rows);
  });

  const snapshot = Effect.fn("RunStoreQueries.snapshot")(function* (runId: RunId) {
    const [storedRuns, storedAttempts, routes] = yield* Effect.all([
      runRows(runId),
      attemptRows(runId),
      eventRouteByRun(runId),
    ]);
    const storedRun = storedRuns[0];
    const route = routes[0];
    if (storedRun === undefined || route === undefined) {
      return yield* new RunNotFoundError({ runId });
    }
    return new RunSnapshot({
      event: eventFromRow(route),
      itemKey: route.itemKey,
      run: runFromRow(storedRun),
      step: stepFromRow(storedRun),
      attempts: storedAttempts.map(attemptFromRow),
      resolvedFailureAttemptId: Option.fromNullishOr(storedRun.resolvedFailureAttemptId),
      repository: storedRun.repository,
      revision: storedRun.revision,
      task: storedRun.task,
      agent: storedRun.agent,
      parentModel: Option.fromNullishOr(storedRun.parentModel),
    });
  });

  const summariesWithAttempts = Effect.fn("RunStoreQueries.summariesWithAttempts")(function* (
    storedRuns: ReadonlyArray<RunRow>,
  ) {
    const runIds = storedRuns.map(({ runId }) => runId);
    // Keep history queries below adapter bind-parameter limits, even for a
    // long-lived Task with many Runs.
    const storedAttempts = (yield* Effect.forEach(EffectArray.chunksOf(runIds, 100), (ids) =>
      database
        .select(attemptSelection)
        .from(attempts)
        .where(inArray(attempts.runId, ids))
        .orderBy(asc(attempts.runId), asc(attempts.attemptNumber))
        .execute()
        .pipe(Effect.flatMap(decodeAttemptRows)),
    )).flat();
    const attemptsByRun = EffectArray.groupBy(storedAttempts, ({ runId }) => runId);
    return storedRuns.map((row): RunSummary =>
      runSummaryFromRow(row, attemptsByRun[row.runId] ?? []),
    );
  });

  const itemRunSummaries = Effect.fn("RunStoreQueries.itemRunSummaries")(function* (
    itemKeys: ReadonlyArray<ItemKey>,
  ) {
    if (itemKeys.length === 0) return [];
    const storedRuns = (yield* Effect.forEach(
      EffectArray.chunksOf([...new Set(itemKeys)], 100),
      (keys) =>
        database
          .select(runSelection)
          .from(runs)
          .innerJoin(triggerEvents, eq(triggerEvents.eventId, runs.eventId))
          .innerJoin(steps, eq(steps.runId, runs.runId))
          .where(inArray(triggerEvents.itemKey, keys))
          .execute()
          .pipe(Effect.flatMap(decodeRunRows)),
    ))
      .flat()
      .sort(newestRunFirst);
    return yield* summariesWithAttempts(storedRuns);
  });

  // Every open Run plus the newest `closedLimit` settled ones, so an old
  // Waiting run never falls out of the operator's view while history stays bounded.
  const runSummaries = Effect.fn("RunStoreQueries.runSummaries")(function* (closedLimit: number) {
    const [openRuns, closedRuns] = yield* Effect.all([
      database
        .select(runSelection)
        .from(runs)
        .innerJoin(triggerEvents, eq(triggerEvents.eventId, runs.eventId))
        .innerJoin(steps, eq(steps.runId, runs.runId))
        .where(openState)
        .orderBy(desc(runs.openedAt), desc(runs.runId))
        .execute()
        .pipe(Effect.flatMap(decodeRunRows)),
      database
        .select(runSelection)
        .from(runs)
        .innerJoin(triggerEvents, eq(triggerEvents.eventId, runs.eventId))
        .innerJoin(steps, eq(steps.runId, runs.runId))
        .where(notInArray(storedStateTag, [...RunState.OPEN_STATE_TAGS]))
        .orderBy(desc(runs.openedAt), desc(runs.runId))
        .limit(closedLimit)
        .execute()
        .pipe(Effect.flatMap(decodeRunRows)),
    ]);
    const storedRuns = [...openRuns, ...closedRuns].sort(newestRunFirst);
    return yield* summariesWithAttempts(storedRuns);
  });

  const revision = Effect.fn("RunStoreQueries.projectionRevision")(function* () {
    const rows = yield* decodeProjectionRevision(
      yield* database
        .select({ revision: projectionRevision.revision })
        .from(projectionRevision)
        .where(eq(projectionRevision.singleton, 1))
        .limit(1)
        .execute(),
    );
    return Option.fromNullishOr(rows[0]?.revision);
  });

  const updateState = Effect.fn("RunStoreQueries.updateState")(function* (
    runId: RunId,
    state: RunState.RunState,
  ) {
    const updated = yield* database
      .update(runs)
      .set({ stateJson: encodeRunState(state) })
      .where(eq(runs.runId, runId))
      .returning({ runId: runs.runId })
      .execute();
    if (updated.length === 0) {
      return yield* new RunNotFoundError({ runId });
    }
  });

  const resolveFailure = Effect.fn("RunStoreQueries.resolveFailure")(function* (
    runId: RunId,
    attemptId: AttemptId,
  ) {
    yield* Effect.annotateCurrentSpan({ runId, attemptId });
    yield* database
      .update(runs)
      .set({ resolvedFailureAttemptId: attemptId })
      .where(eq(runs.runId, runId))
      .execute();
  });

  const addAttempt = Effect.fn("RunStoreQueries.addAttempt")(function* (attempt: Attempt) {
    yield* database
      .insert(attempts)
      .values({
        attemptId: attempt.id,
        runId: attempt.runId,
        stepName: attempt.stepName,
        workerName: attempt.worker,
        attemptNumber: attempt.number,
        brainJson: encodeBrainSpec(attempt.brain),
        task: attempt.task,
        agent: attempt.agent,
        operatorIntervened: attempt.operatorIntervened,
        parentModel: Option.getOrNull(attempt.parentModel),
        startedAt: encodeDateTime(attempt.startedAt),
        outcomeJson: null,
        salvageJson: null,
      })
      .execute();
  });

  const recordSalvage = Effect.fn("RunStoreQueries.recordSalvage")(function* (
    attemptId: AttemptId,
    salvage: AttemptSalvage,
  ) {
    yield* Effect.annotateCurrentSpan({ attemptId, salvage: salvage._tag });
    yield* database
      .update(attempts)
      .set({ salvageJson: encodeSalvage(salvage) })
      .where(eq(attempts.attemptId, attemptId))
      .execute();
  });

  const closeAttempt = Effect.fn("RunStoreQueries.closeAttempt")(function* (
    attemptId: AttemptId,
    outcome: AttemptOutcome,
  ) {
    yield* database
      .update(attempts)
      .set({ outcomeJson: encodeOutcome(outcome) })
      .where(and(eq(attempts.attemptId, attemptId), isNull(attempts.outcomeJson)))
      .execute();
  });

  const amend = Effect.fn("RunStoreQueries.amend")(function* (
    runId: RunId,
    context: AttemptContext,
  ) {
    yield* Effect.annotateCurrentSpan({ runId, agent: context.agent.name });
    yield* database
      .update(runs)
      .set({
        task: context.task,
        agentJson: storedAgent(context.agent),
        parentModel: Option.getOrNull(context.parentModel),
      })
      .where(eq(runs.runId, runId))
      .execute();
  });

  const markIntervened = Effect.fn("RunStoreQueries.markIntervened")(function* (
    attemptId: AttemptId,
  ) {
    yield* Effect.annotateCurrentSpan({ attemptId });
    yield* database
      .update(attempts)
      .set({ operatorIntervened: true })
      .where(eq(attempts.attemptId, attemptId))
      .execute();
  });

  const updateAttemptParentModel = Effect.fn("RunStoreQueries.updateAttemptParentModel")(function* (
    attemptId: AttemptId,
    parentModel: ModelId,
  ) {
    yield* database
      .update(attempts)
      .set({ parentModel })
      .where(eq(attempts.attemptId, attemptId))
      .execute();
  });

  const updateStepResult = Effect.fn("RunStoreQueries.updateStepResult")(function* (
    runId: RunId,
    stepName: StepName,
    result: StepResult,
  ) {
    yield* database
      .update(steps)
      .set({ result: encodeStepResult(result) })
      .where(and(eq(steps.runId, runId), eq(steps.stepName, stepName)))
      .execute();
  });

  const approvalExists = Effect.fn("RunStoreQueries.approvalExists")(function* (runId: RunId) {
    return (yield* database.$count(approvals, eq(approvals.runId, runId)).execute()) > 0;
  });

  const recordApproval = Effect.fn("RunStoreQueries.recordApproval")(function* (
    runId: RunId,
    approval: Event,
  ) {
    yield* database
      .insert(events)
      .values({
        eventId: approval.id,
        dedupKey: approval.dedupKey,
        payloadJson: encodePayload(approval.payload),
        receivedAt: encodeDateTime(approval.receivedAt),
      })
      .onConflictDoNothing()
      .execute();
    yield* database.insert(approvals).values({ runId, eventId: approval.id }).execute();
  });

  const requestWorkflowCommand = Effect.fn("RunStoreQueries.requestWorkflowCommand")(function* (
    runId: RunId,
    command: WorkflowCommand,
  ) {
    yield* database
      .insert(workflowCommands)
      .values({ runId, command })
      .onConflictDoNothing()
      .execute();
  });

  const requestInterrupt = Effect.fn("RunStoreQueries.requestInterrupt")(function* (runId: RunId) {
    yield* database
      .delete(workflowCommands)
      .where(
        and(
          eq(workflowCommands.runId, runId),
          inArray(workflowCommands.command, ["Approve", "Resume"]),
        ),
      )
      .execute();
    yield* requestWorkflowCommand(runId, "Interrupt");
  });

  const workflowCommandsFor = Effect.fn("RunStoreQueries.workflowCommandsFor")(function* (
    runId: RunId,
  ) {
    yield* Effect.annotateCurrentSpan({ runId });
    const rows = yield* database
      .select({ runId: workflowCommands.runId, command: workflowCommands.command })
      .from(workflowCommands)
      .where(eq(workflowCommands.runId, runId))
      .execute();
    return (yield* decodeWorkflowCommands(rows)).map(({ command }) => command);
  });

  const createRun = Effect.fn("RunStoreQueries.createRun")(function* (
    submission: Submission,
    eventId: EventId,
    runId: RunId,
  ) {
    const candidate = alias(triggerEvents, "candidate");
    const candidateRun = alias(runs, "candidate_run");
    const ignored = alias(ignoredEvents, "ignored");
    yield* database
      .insert(ignoredEvents)
      .select(
        database
          .select({
            eventId: candidate.eventId,
            reason: sql<"superseded">`'superseded'`.as("reason"),
          })
          .from(candidate)
          .leftJoin(candidateRun, eq(candidateRun.eventId, candidate.eventId))
          .leftJoin(ignored, eq(ignored.eventId, candidate.eventId))
          .where(
            and(
              eq(candidate.loopName, submission.loop),
              eq(candidate.itemKey, submission.itemKey),
              ne(candidate.eventId, eventId),
              isNull(candidateRun.runId),
              isNull(ignored.eventId),
            ),
          ),
      )
      .onConflictDoNothing()
      .execute();
    yield* database
      .insert(runs)
      .values({
        runId,
        eventId,
        loopName: submission.loop,
        stateJson: encodeRunState(new RunState.Pending()),
        openedAt: encodeDateTime(submission.event.receivedAt),
        repository: submission.repository,
        revision: submission.revision,
        task: submission.task,
        agentJson: storedAgent(submission.agent),
        parentModel: Option.getOrNull(submission.parentModel),
      })
      .onConflictDoNothing()
      .execute();
    yield* database
      .insert(steps)
      .values({ runId, stepName: submission.step, result: null })
      .onConflictDoNothing()
      .execute();
  });

  const runForEvent = Effect.fn("RunStoreQueries.runForEvent")(function* (eventId: EventId) {
    return yield* decodeRunIds(
      yield* database
        .select({ runId: runs.runId })
        .from(runs)
        .where(eq(runs.eventId, eventId))
        .execute(),
    );
  });

  const ignoredEvent = Effect.fn("RunStoreQueries.ignoredEvent")(function* (eventId: EventId) {
    return yield* decodeDiscards(
      yield* database
        .select({ reason: ignoredEvents.reason })
        .from(ignoredEvents)
        .where(eq(ignoredEvents.eventId, eventId))
        .execute(),
    );
  });

  const blockingRun = Effect.fn("RunStoreQueries.blockingRun")(function* (
    loop: LoopName,
    itemKey: ItemKey,
  ) {
    return yield* decodeRunIds(
      yield* database
        .select({ runId: runs.runId })
        .from(runs)
        .innerJoin(triggerEvents, eq(triggerEvents.eventId, runs.eventId))
        .where(and(eq(triggerEvents.loopName, loop), eq(triggerEvents.itemKey, itemKey), openState))
        .orderBy(desc(runs.openedAt))
        .limit(1)
        .execute(),
    );
  });

  const recordTriggerEvent = Effect.fn("RunStoreQueries.recordTriggerEvent")(function* (
    submission: Submission,
  ) {
    yield* database
      .insert(events)
      .values({
        eventId: submission.event.id,
        dedupKey: submission.event.dedupKey,
        payloadJson: encodePayload(submission.event.payload),
        receivedAt: encodeDateTime(submission.event.receivedAt),
      })
      .onConflictDoNothing()
      .execute();
    const routes = yield* eventRouteByDedup(submission.event.dedupKey);
    const existing = routes[0];
    if (existing === undefined) {
      yield* database
        .insert(triggerEvents)
        .values({
          eventId: submission.event.id,
          itemKey: submission.itemKey,
          loopName: submission.loop,
          stepName: submission.step,
          approval: submission.approval,
          cycleLimit: Option.getOrNull(submission.cycleLimit),
          cycleGeneration: submission.cycleGeneration,
          repository: submission.repository,
          revision: submission.revision,
          task: submission.task,
          agentJson: storedAgent(submission.agent),
          parentModel: Option.getOrNull(submission.parentModel),
        })
        .execute();
      return submission;
    }
    return submissionFromRow(existing);
  });

  const nextQueued = Effect.fn("RunStoreQueries.nextQueued")(function* (runId: RunId) {
    const routes = yield* eventRouteByRun(runId);
    const current = routes[0];
    if (current === undefined) return Option.none<QueuedEvents>();
    const queuedRows = yield* database
      .select(eventRouteSelection)
      .from(events)
      .innerJoin(triggerEvents, eq(triggerEvents.eventId, events.eventId))
      .leftJoin(runs, eq(runs.eventId, events.eventId))
      .leftJoin(ignoredEvents, eq(ignoredEvents.eventId, events.eventId))
      .where(
        and(
          eq(triggerEvents.loopName, current.loop),
          eq(triggerEvents.itemKey, current.itemKey),
          cycleQueries(database).currentEvent,
          isNull(runs.runId),
          isNull(ignoredEvents.eventId),
        ),
      )
      .orderBy(desc(events.receivedAt))
      .execute();
    const queued = yield* decodeEventRoutes(queuedRows);
    return Option.fromNullishOr(queued[0]).pipe(
      Option.map((newest): QueuedEvents => ({
        submission: submissionFromRow(newest),
        eventIds: queued.map((row) => row.eventId),
      })),
    );
  });

  const recoverable = Effect.fn("RunStoreQueries.recoverable")(function* () {
    const rows = yield* database
      .select({
        ...eventRouteSelection,
        runId: runs.runId,
        state: runs.stateJson,
      })
      .from(runs)
      .innerJoin(events, eq(events.eventId, runs.eventId))
      .innerJoin(triggerEvents, eq(triggerEvents.eventId, events.eventId))
      .where(openState)
      .execute();
    return yield* decodeRecoverableRuns(rows);
  });

  const pendingWorkflowCommands = Effect.fn("RunStoreQueries.pendingWorkflowCommands")(
    function* () {
      const rows = yield* database
        .select({ runId: workflowCommands.runId, command: workflowCommands.command })
        .from(workflowCommands)
        .execute();
      const decoded = yield* decodeWorkflowCommands(rows);
      // Delivery order per run is a replay invariant; WORKFLOW_COMMAND_PRIORITY names it.
      const priority = (command: WorkflowCommand) => WORKFLOW_COMMAND_PRIORITY.indexOf(command);
      return [...decoded].sort((left, right) =>
        left.runId === right.runId
          ? priority(left.command) - priority(right.command)
          : left.runId < right.runId
            ? -1
            : 1,
      );
    },
  );

  const completeWorkflowCommand = Effect.fn("RunStoreQueries.completeWorkflowCommand")(function* (
    runId: RunId,
    command: WorkflowCommand,
  ) {
    yield* database
      .delete(workflowCommands)
      .where(and(eq(workflowCommands.runId, runId), eq(workflowCommands.command, command)))
      .execute();
  });

  const revokeQueued = Effect.fn("RunStoreQueries.revokeQueued")(function* (
    loop: LoopName,
    itemKey: ItemKey,
    eventIds: ReadonlyArray<EventId> | SQLWrapper,
  ) {
    const candidate = alias(triggerEvents, "candidate");
    const candidateRun = alias(runs, "candidate_run");
    const ignored = yield* database
      .insert(ignoredEvents)
      .select(
        database
          .select({
            eventId: candidate.eventId,
            reason: sql<"revoked">`'revoked'`.as("reason"),
          })
          .from(candidate)
          .leftJoin(candidateRun, eq(candidateRun.eventId, candidate.eventId))
          .where(
            and(
              eq(candidate.loopName, loop),
              eq(candidate.itemKey, itemKey),
              inArray(candidate.eventId, eventIds),
              isNull(candidateRun.runId),
            ),
          ),
      )
      .onConflictDoNothing()
      .returning({ eventId: ignoredEvents.eventId })
      .execute();
    return ignored.length;
  });

  const revokeUnstarted = Effect.fn("RunStoreQueries.revokeUnstarted")(function* (
    loop: LoopName,
    itemKey: ItemKey,
  ) {
    const rows = yield* decodeRunIds(
      yield* database
        .select({ runId: runs.runId })
        .from(runs)
        .innerJoin(triggerEvents, eq(triggerEvents.eventId, runs.eventId))
        .where(
          and(eq(triggerEvents.loopName, loop), eq(triggerEvents.itemKey, itemKey), unstartedState),
        )
        .execute(),
    );
    const queued = database
      .select({ eventId: triggerEvents.eventId })
      .from(triggerEvents)
      .where(and(eq(triggerEvents.loopName, loop), eq(triggerEvents.itemKey, itemKey)));
    yield* revokeQueued(loop, itemKey, queued);
    return rows;
  });

  return {
    salvageCandidates,
    cycles: cycleQueries(database),
    ...transcriptQueries(database),
    addAttempt,
    recordSalvage,
    amend,
    markIntervened,
    approvalExists,
    blockingRun,
    closeAttempt,
    completeWorkflowCommand,
    createRun,
    eventRouteByRun,
    workflowCommandsFor,
    ignoredEvent,
    nextQueued,
    pendingWorkflowCommands,
    recordTriggerEvent,
    recoverable,
    recordApproval,
    requestInterrupt,
    requestWorkflowCommand,
    revision,
    revokeQueued,
    revokeUnstarted,
    runSummaries,
    itemRunSummaries,
    runForEvent,
    snapshot,
    updateStepResult,
    updateAttemptParentModel,
    updateState,
    resolveFailure,
  } as const;
};
