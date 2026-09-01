import {
  Attempt,
  AttemptChannel,
  Event,
  Item,
  Loop,
  Run,
  RunState,
  Step,
  StepResult,
} from "@usine/core";
import type { Agent } from "@usine/core";
import { and, asc, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { DateTime, Effect, Option, Schema } from "effect";
import type { RunDatabaseClient } from "../database/database.ts";
import {
  approvals,
  attemptTranscripts,
  attempts,
  events,
  ignoredEvents,
  projectionRevision,
  runs,
  steps,
  triggerEvents,
  workflowCommands,
} from "../database/schema.ts";
import {
  RunNotFoundError,
  RunSnapshot,
  RunSummary,
  Submission,
  TranscriptQuery,
  WORKFLOW_COMMAND_PRIORITY,
  type WorkflowCommand,
} from "../model.ts";
import {
  attemptFromRow,
  decodeAttemptRows,
  decodeDiscards,
  decodeEventRoutes,
  decodeRecoverableRuns,
  decodeProjectionRevision,
  decodeRunIds,
  decodeRunRows,
  decodeWorkflowCommands,
  decodeTranscriptRows,
  encodeAgent,
  encodeBrainSpec,
  encodeDateTime,
  encodeEnvelope,
  encodeOutcome,
  encodePayload,
  encodeRunState,
  encodeStepResult,
  eventFromRow,
  runFromRow,
  runSummaryFromRow,
  stepFromRow,
  submissionFromRow,
  transcriptEntryFromRow,
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
  repository: triggerEvents.repository,
  revision: triggerEvents.revision,
  task: triggerEvents.task,
  agent: triggerEvents.agentJson,
  parentModel: triggerEvents.parentModel,
} as const;

const runSelection = {
  runId: runs.runId,
  eventId: runs.eventId,
  loop: runs.loopName,
  state: runs.stateJson,
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
  parentModel: attempts.parentModel,
  startedAt: attempts.startedAt,
  outcome: attempts.outcomeJson,
} as const;

// The state partitions stay owned by @usine/core (`RunState.Open` and the
// supersede/revoke precondition); these predicates only borrow their tags.
const storedStateTag = sql`json_extract(${runs.stateJson}, '$._tag')`;
const openState = inArray(storedStateTag, [...RunState.OPEN_STATE_TAGS]);
const unstartedState = inArray(storedStateTag, [...RunState.UNSTARTED_STATE_TAGS]);
// The Json round-trip is the portable named type for `queriesFor`'s inferred
// signature — without it tsc cannot emit the declaration (TS2883).
const storedAgent = (agent: Agent.Agent): Schema.Json =>
  Schema.decodeUnknownSync(Schema.Json)(encodeAgent(agent));

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
      .select(runSelection)
      .from(runs)
      .innerJoin(steps, eq(steps.runId, runs.runId))
      .where(eq(runs.runId, runId))
      .execute();
    return yield* decodeRunRows(rows);
  });

  const attemptRows = Effect.fn("RunStoreQueries.attemptRows")(function* (runId: Run.RunId) {
    const rows = yield* database
      .select(attemptSelection)
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
      repository: storedRun.repository,
      revision: storedRun.revision,
      task: storedRun.task,
      agent: storedRun.agent,
      parentModel: Option.fromNullishOr(storedRun.parentModel),
    });
  });

  const runSummaries = Effect.fn("RunStoreQueries.runSummaries")(function* () {
    const [storedRuns, storedAttempts] = yield* Effect.all([
      database
        .select(runSelection)
        .from(runs)
        .innerJoin(steps, eq(steps.runId, runs.runId))
        .orderBy(desc(runs.openedAt), desc(runs.runId))
        .execute()
        .pipe(Effect.flatMap(decodeRunRows)),
      database
        .select(attemptSelection)
        .from(attempts)
        .orderBy(asc(attempts.runId), asc(attempts.attemptNumber))
        .execute()
        .pipe(Effect.flatMap(decodeAttemptRows)),
    ]);
    const attemptsByRun = new Map<Run.RunId, Array<(typeof storedAttempts)[number]>>();
    for (const attempt of storedAttempts) {
      const grouped = attemptsByRun.get(attempt.runId) ?? [];
      grouped.push(attempt);
      attemptsByRun.set(attempt.runId, grouped);
    }
    return storedRuns.map((row): RunSummary =>
      runSummaryFromRow(row, attemptsByRun.get(row.runId) ?? []),
    );
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
        workerName: attempt.worker,
        attemptNumber: attempt.number,
        brainJson: encodeBrainSpec(attempt.brain),
        parentModel: Option.getOrNull(attempt.parentModel),
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

  const updateAttemptParentModel = Effect.fn("RunStoreQueries.updateAttemptParentModel")(function* (
    attemptId: Attempt.AttemptId,
    parentModel: Agent.ModelId,
  ) {
    yield* database
      .update(attempts)
      .set({ parentModel })
      .where(eq(attempts.attemptId, attemptId))
      .execute();
  });

  const updateStepResult = Effect.fn("RunStoreQueries.updateStepResult")(function* (
    runId: Run.RunId,
    stepName: Step.StepName,
    result: StepResult.StepResult,
  ) {
    yield* database
      .update(steps)
      .set({ result: encodeStepResult(result) })
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

  const appendTranscript = Effect.fn("RunStoreQueries.appendTranscript")(function* (
    direction: AttemptChannel.Direction,
    envelope: AttemptChannel.Envelope,
    receivedAt: DateTime.Utc,
  ) {
    yield* database
      .insert(attemptTranscripts)
      .values({
        attemptId: envelope.attemptId,
        direction,
        channelSequence: envelope.sequence,
        envelope: encodeEnvelope(envelope),
        receivedAt: encodeDateTime(receivedAt),
      })
      .onConflictDoNothing()
      .execute();
  });

  const transcript = Effect.fn("RunStoreQueries.transcript")(function* (query: TranscriptQuery) {
    const cursor = Option.match(query.after, {
      onNone: () => eq(attemptTranscripts.attemptId, query.attemptId),
      onSome: (sequence) =>
        and(
          eq(attemptTranscripts.attemptId, query.attemptId),
          gt(attemptTranscripts.sequence, sequence),
        ),
    });
    const rows = yield* database
      .select({
        sequence: attemptTranscripts.sequence,
        attemptId: attemptTranscripts.attemptId,
        direction: attemptTranscripts.direction,
        envelope: attemptTranscripts.envelope,
        receivedAt: attemptTranscripts.receivedAt,
      })
      .from(attemptTranscripts)
      .where(cursor)
      .orderBy(asc(attemptTranscripts.sequence))
      .execute();
    // Transcript rows are usine-owned: an unknown key is corruption, not tolerance.
    return (yield* decodeTranscriptRows(rows, { onExcessProperty: "error" })).map(
      transcriptEntryFromRow,
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
    appendTranscript,
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
    revision,
    revokeUnstarted,
    runSummaries,
    runForEvent,
    snapshot,
    transcript,
    updateStepResult,
    updateAttemptParentModel,
    updateState,
  } as const;
};
