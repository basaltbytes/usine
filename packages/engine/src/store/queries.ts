import { Attempt, Event, Item, Loop, Run, RunState, Step } from "@usine/core";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { Effect, Option } from "effect";
import type { RunDatabaseClient } from "../database/database.ts";
import {
  approvals,
  attempts,
  events,
  ignoredEvents,
  runs,
  steps,
  triggerEvents,
  workflowCommands,
} from "../database/schema.ts";
import {
  RunNotFoundError,
  RunSnapshot,
  Submission,
  WORKFLOW_COMMAND_PRIORITY,
  type WorkflowCommand,
} from "../model.ts";
import {
  attemptFromRow,
  decodeAttemptRows,
  decodeDiscards,
  decodeEventRoutes,
  decodeRecoverableRuns,
  decodeRunIds,
  decodeRunRows,
  decodeWorkflowCommands,
  encodeDateTime,
  encodeOutcome,
  encodePayload,
  encodeRunState,
  eventFromRow,
  runFromRow,
  stepFromRow,
  submissionFromRow,
} from "./codec.ts";

const eventRouteSelection = {
  eventId: events.eventId,
  dedupKey: events.dedupKey,
  payload: events.payloadJson,
  receivedAt: events.receivedAt,
  itemKey: triggerEvents.itemKey,
  loop: triggerEvents.loopName,
  step: triggerEvents.stepName,
  approval: triggerEvents.approval,
} as const;

// The state partitions stay owned by @usine/core (`RunState.Open` and the
// supersede/revoke precondition); these predicates only borrow their tags.
const storedStateTag = sql`json_extract(${runs.stateJson}, '$._tag')`;
const openState = inArray(storedStateTag, [...RunState.OPEN_STATE_TAGS]);
const unstartedState = inArray(storedStateTag, [...RunState.UNSTARTED_STATE_TAGS]);

export const queriesFor = (database: RunDatabaseClient) => {
  // Keep `.execute()` explicit: RC.4's yieldable wrapper can cross an Effect
  // Workflow suspension before its final mutation is observable (ADR 0020).
  const eventRouteByDedup = Effect.fn("RunStoreQueries.eventRouteByDedup")(function* (
    dedupKey: Event.DedupKey,
  ) {
    const rows = yield* database
      .select(eventRouteSelection)
      .from(events)
      .innerJoin(triggerEvents, eq(triggerEvents.eventId, events.eventId))
      .where(eq(events.dedupKey, dedupKey))
      .execute();
    return yield* decodeEventRoutes(rows);
  });

  const eventRouteByRun = Effect.fn("RunStoreQueries.eventRouteByRun")(function* (
    runId: Run.RunId,
  ) {
    const rows = yield* database
      .select(eventRouteSelection)
      .from(runs)
      .innerJoin(events, eq(events.eventId, runs.eventId))
      .innerJoin(triggerEvents, eq(triggerEvents.eventId, events.eventId))
      .where(eq(runs.runId, runId))
      .execute();
    return yield* decodeEventRoutes(rows);
  });

  const runRows = Effect.fn("RunStoreQueries.runRows")(function* (runId: Run.RunId) {
    const rows = yield* database
      .select({
        runId: runs.runId,
        eventId: runs.eventId,
        loop: runs.loopName,
        state: runs.stateJson,
        openedAt: runs.openedAt,
        stepName: steps.stepName,
        result: steps.result,
      })
      .from(runs)
      .innerJoin(steps, eq(steps.runId, runs.runId))
      .where(eq(runs.runId, runId))
      .execute();
    return yield* decodeRunRows(rows);
  });

  const attemptRows = Effect.fn("RunStoreQueries.attemptRows")(function* (runId: Run.RunId) {
    const rows = yield* database
      .select({
        attemptId: attempts.attemptId,
        runId: attempts.runId,
        stepName: attempts.stepName,
        number: attempts.attemptNumber,
        startedAt: attempts.startedAt,
        outcome: attempts.outcomeJson,
      })
      .from(attempts)
      .where(eq(attempts.runId, runId))
      .orderBy(attempts.attemptNumber)
      .execute();
    return yield* decodeAttemptRows(rows);
  });

  const snapshot = Effect.fn("RunStoreQueries.snapshot")(function* (runId: Run.RunId) {
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
      run: runFromRow(storedRun),
      step: stepFromRow(storedRun),
      attempts: storedAttempts.map(attemptFromRow),
    });
  });

  const updateState = Effect.fn("RunStoreQueries.updateState")(function* (
    runId: Run.RunId,
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

  const addAttempt = Effect.fn("RunStoreQueries.addAttempt")(function* (attempt: Attempt.Attempt) {
    yield* database
      .insert(attempts)
      .values({
        attemptId: attempt.id,
        runId: attempt.runId,
        stepName: attempt.stepName,
        attemptNumber: attempt.number,
        startedAt: encodeDateTime(attempt.startedAt),
        outcomeJson: null,
      })
      .execute();
  });

  const closeAttempt = Effect.fn("RunStoreQueries.closeAttempt")(function* (
    attemptId: Attempt.AttemptId,
    outcome: Attempt.Outcome,
  ) {
    yield* database
      .update(attempts)
      .set({ outcomeJson: encodeOutcome(outcome) })
      .where(and(eq(attempts.attemptId, attemptId), isNull(attempts.outcomeJson)))
      .execute();
  });

  const updateStepResult = Effect.fn("RunStoreQueries.updateStepResult")(function* (
    runId: Run.RunId,
    stepName: Step.StepName,
    result: string,
  ) {
    yield* database
      .update(steps)
      .set({ result })
      .where(and(eq(steps.runId, runId), eq(steps.stepName, stepName)))
      .execute();
  });

  const approvalExists = Effect.fn("RunStoreQueries.approvalExists")(function* (runId: Run.RunId) {
    return (yield* database.$count(approvals, eq(approvals.runId, runId)).execute()) > 0;
  });

  const recordApproval = Effect.fn("RunStoreQueries.recordApproval")(function* (
    runId: Run.RunId,
    approval: Event.Event,
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
    runId: Run.RunId,
    command: WorkflowCommand,
  ) {
    yield* database
      .insert(workflowCommands)
      .values({ runId, command })
      .onConflictDoNothing()
      .execute();
  });

  const requestInterrupt = Effect.fn("RunStoreQueries.requestInterrupt")(function* (
    runId: Run.RunId,
  ) {
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

  const hasWorkflowCommand = Effect.fn("RunStoreQueries.hasWorkflowCommand")(function* (
    runId: Run.RunId,
    command: WorkflowCommand,
  ) {
    return (
      (yield* database
        .$count(
          workflowCommands,
          and(eq(workflowCommands.runId, runId), eq(workflowCommands.command, command)),
        )
        .execute()) > 0
    );
  });

  const createRun = Effect.fn("RunStoreQueries.createRun")(function* (
    submission: Submission,
    eventId: Event.EventId,
    runId: Run.RunId,
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
      })
      .onConflictDoNothing()
      .execute();
    yield* database
      .insert(steps)
      .values({ runId, stepName: submission.step, result: null })
      .onConflictDoNothing()
      .execute();
  });

  const runForEvent = Effect.fn("RunStoreQueries.runForEvent")(function* (eventId: Event.EventId) {
    return yield* decodeRunIds(
      yield* database
        .select({ runId: runs.runId })
        .from(runs)
        .where(eq(runs.eventId, eventId))
        .execute(),
    );
  });

  const ignoredEvent = Effect.fn("RunStoreQueries.ignoredEvent")(function* (
    eventId: Event.EventId,
  ) {
    return yield* decodeDiscards(
      yield* database
        .select({ reason: ignoredEvents.reason })
        .from(ignoredEvents)
        .where(eq(ignoredEvents.eventId, eventId))
        .execute(),
    );
  });

  const blockingRun = Effect.fn("RunStoreQueries.blockingRun")(function* (
    loop: Loop.LoopName,
    itemKey: Item.ItemKey,
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
        })
        .execute();
      return submission;
    }
    return submissionFromRow(existing);
  });

  const nextQueued = Effect.fn("RunStoreQueries.nextQueued")(function* (runId: Run.RunId) {
    const routes = yield* eventRouteByRun(runId);
    const current = routes[0];
    if (current === undefined) return Option.none<Submission>();
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
          isNull(runs.runId),
          isNull(ignoredEvents.eventId),
        ),
      )
      .orderBy(desc(events.receivedAt))
      .limit(1)
      .execute();
    const queued = yield* decodeEventRoutes(queuedRows);
    return Option.fromNullishOr(queued[0]).pipe(Option.map(submissionFromRow));
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
      // Delivery order per run is a replay invariant, not a sort convenience —
      // WORKFLOW_COMMAND_PRIORITY names it.
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
    runId: Run.RunId,
    command: WorkflowCommand,
  ) {
    yield* database
      .delete(workflowCommands)
      .where(and(eq(workflowCommands.runId, runId), eq(workflowCommands.command, command)))
      .execute();
  });

  const revokeUnstarted = Effect.fn("RunStoreQueries.revokeUnstarted")(function* (
    loop: Loop.LoopName,
    itemKey: Item.ItemKey,
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
    const candidate = alias(triggerEvents, "candidate");
    const candidateRun = alias(runs, "candidate_run");
    yield* database
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
              isNull(candidateRun.runId),
            ),
          ),
      )
      .onConflictDoNothing()
      .execute();
    return rows;
  });

  return {
    addAttempt,
    approvalExists,
    blockingRun,
    closeAttempt,
    completeWorkflowCommand,
    createRun,
    eventRouteByRun,
    hasWorkflowCommand,
    ignoredEvent,
    nextQueued,
    pendingWorkflowCommands,
    recordTriggerEvent,
    recoverable,
    recordApproval,
    requestInterrupt,
    requestWorkflowCommand,
    revokeUnstarted,
    runForEvent,
    snapshot,
    updateStepResult,
    updateState,
  } as const;
};
