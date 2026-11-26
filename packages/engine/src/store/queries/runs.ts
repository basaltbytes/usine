import type { RecordChange } from "../changes.ts";
import { changeRecorder } from "../changes.ts";
import type { AttemptContext, AttemptId, FailureResolution } from "@usine/core/attempt";
import type { OperatorRetryStart } from "@usine/core/attempt/start";
import type { Event, EventId } from "@usine/core/event";
import type { ItemKey } from "@usine/core/item";
import type { LoopName } from "@usine/core/loop";
import type { RunId } from "@usine/core/run";
import type { ApprovalSource } from "@usine/core/run/approval";
import type { StepName } from "@usine/core/step";
import * as RunState from "@usine/core/run/state";
import type { StepResult } from "@usine/core/step/result";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { DateTime, Effect, Option } from "effect";
import { jsonExtract } from "../../database/dialect.ts";
import type { RunDatabaseClient } from "../../database/database.ts";
import {
  approvals,
  attempts,
  events,
  ignoredEvents,
  runAgainEvents,
  runs,
  steps,
  triggerEvents,
} from "../../database/schema.ts";
import { RunNotFoundError } from "../../engine/error.ts";
import { RunSnapshot } from "../../run-reader/model.ts";
import type { Submission } from "../../engine/submission.ts";
import {
  approvalFromRow,
  attemptFromRow,
  decodeNextStarts,
  decodeRunIds,
  decodeRunRows,
  encodeAgent,
  encodeAttemptStart,
  encodeDateTime,
  encodeFailureResolution,
  encodePayload,
  encodeRunState,
  encodeStepResult,
  eventFromRow,
  runAgainFromRow,
  runFromRow,
  stepFromRow,
} from "../codec.ts";
import { attemptQueries } from "./attempts.ts";
import { eventQueries } from "./events.ts";

export const approvalEvents = alias(events, "approval_event");

export const runSelection = {
  itemKey: triggerEvents.itemKey,
  runId: runs.runId,
  eventId: runs.eventId,
  loop: runs.loopName,
  state: runs.stateJson,
  resolvedFailureAttemptId: runs.resolvedFailureAttemptId,
  openedAt: runs.openedAt,
  closedAt: runs.closedAt,
  repository: runs.repository,
  revision: runs.revision,
  task: runs.task,
  agent: runs.agentJson,
  stepName: steps.stepName,
  result: steps.result,
  approvalReason: triggerEvents.approvalReason,
  approvedAt: approvalEvents.receivedAt,
  approvalChannel: approvals.channel,
  approver: approvals.approver,
  againFrom: runAgainEvents.fromRunId,
  againRequestedBy: runAgainEvents.requestedBy,
} as const;

const storedStateTag = jsonExtract(runs.stateJson, "$._tag");
export const openState = inArray(storedStateTag, [...RunState.OPEN_STATE_TAGS]);
export const unstartedState = inArray(storedStateTag, [...RunState.UNSTARTED_STATE_TAGS]);

/** Returns the Run row queries that run on the caller's transaction. */
export const runQueries = (database: RunDatabaseClient, record?: RecordChange) => {
  const { changedRun, changedAttempt } = changeRecorder(database, record);
  const { attemptRows } = attemptQueries(database, record);
  const { eventRouteByRun } = eventQueries(database);

  const selectRuns = () =>
    database
      .select(runSelection)
      .from(runs)
      .innerJoin(triggerEvents, eq(triggerEvents.eventId, runs.eventId))
      .innerJoin(steps, eq(steps.runId, runs.runId))
      .leftJoin(approvals, eq(approvals.runId, runs.runId))
      .leftJoin(approvalEvents, eq(approvalEvents.eventId, approvals.eventId))
      .leftJoin(runAgainEvents, eq(runAgainEvents.eventId, runs.eventId));

  const runRows = Effect.fn("RunStoreQueries.runRows")(function* (runId: RunId) {
    const rows = yield* selectRuns().where(eq(runs.runId, runId)).execute();
    return yield* decodeRunRows(rows);
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
      return yield* RunNotFoundError.make({ runId });
    }
    return RunSnapshot.make({
      event: eventFromRow(route),
      itemKey: route.itemKey,
      run: runFromRow(storedRun),
      step: stepFromRow(storedRun),
      attempts: storedAttempts.map(attemptFromRow),
      resolvedFailureAttemptId: Option.fromNullishOr(storedRun.resolvedFailureAttemptId),
      closedAt: Option.fromNullishOr(storedRun.closedAt),
      approval: approvalFromRow(storedRun),
      approvalReason: Option.fromNullishOr(storedRun.approvalReason),
      runAgain: runAgainFromRow(storedRun),
      repository: storedRun.repository,
      revision: storedRun.revision,
      task: storedRun.task,
      agent: storedRun.agent,
      permissions: route.permissions,
      ciPolicy: Option.fromNullishOr(route.ciPolicy),
      outcomeLabels: route.outcomeLabels,
    });
  });

  // A closed state sets `closedAt` to `at` or now; an open state clears it.
  const updateState = Effect.fn("RunStoreQueries.updateState")(function* (
    runId: RunId,
    state: RunState.RunState,
    at?: DateTime.Utc,
  ) {
    const closedAt = RunState.isOpen(state) ? null : encodeDateTime(at ?? (yield* DateTime.now));
    const stateJson = yield* encodeRunState(state);
    const updated = yield* database
      .update(runs)
      .set({ stateJson: stateJson, closedAt })
      .where(eq(runs.runId, runId))
      .returning({ runId: runs.runId })
      .execute();
    if (updated.length === 0) {
      return yield* RunNotFoundError.make({ runId });
    }
    yield* changedRun(runId);
  });

  const resolveFailure = Effect.fn("RunStoreQueries.resolveFailure")(function* (
    runId: RunId,
    attemptId: AttemptId,
    resolution: FailureResolution,
  ) {
    yield* Effect.annotateCurrentSpan({ runId, attemptId });
    const resolutionJson = yield* encodeFailureResolution(resolution);
    yield* database
      .update(attempts)
      .set({ failureResolutionJson: resolutionJson })
      .where(eq(attempts.attemptId, attemptId))
      .execute();
    yield* database
      .update(runs)
      .set({ resolvedFailureAttemptId: attemptId })
      .where(eq(runs.runId, runId))
      .execute();
    yield* changedAttempt(attemptId);
  });

  /** Returns the operator retry for the Run's next Attempt, or `None`. */
  const nextStart = Effect.fn("RunStoreQueries.nextStart")(function* (runId: RunId) {
    const rows = yield* database
      .select({ nextStart: runs.nextStartJson })
      .from(runs)
      .where(eq(runs.runId, runId))
      .execute();

    return Option.fromNullishOr((yield* decodeNextStarts(rows))[0]?.nextStart);
  });

  const setNextStart = Effect.fn("RunStoreQueries.setNextStart")(function* (
    runId: RunId,
    start: Option.Option<OperatorRetryStart>,
  ) {
    const startJson = yield* Option.match(start, {
      onNone: () => Effect.succeed(null),
      onSome: encodeAttemptStart,
    });
    yield* database
      .update(runs)
      .set({
        nextStartJson: startJson,
      })
      .where(eq(runs.runId, runId))
      .execute();
    yield* changedRun(runId);
  });

  const amend = Effect.fn("RunStoreQueries.amend")(function* (
    runId: RunId,
    context: AttemptContext,
  ) {
    yield* Effect.annotateCurrentSpan({ runId, agent: context.agent.name });
    const agentJson = yield* encodeAgent(context.agent);
    yield* database
      .update(runs)
      .set({
        task: context.task,
        agentJson: agentJson,
      })
      .where(eq(runs.runId, runId))
      .execute();
    yield* changedRun(runId);
  });

  const updateStepResult = Effect.fn("RunStoreQueries.updateStepResult")(function* (
    runId: RunId,
    stepName: StepName,
    result: StepResult,
  ) {
    const resultJson = yield* encodeStepResult(result);
    yield* database
      .update(steps)
      .set({ result: resultJson })
      .where(and(eq(steps.runId, runId), eq(steps.stepName, stepName)))
      .execute();
    yield* changedRun(runId);
  });

  const approvalExists = Effect.fn("RunStoreQueries.approvalExists")(function* (runId: RunId) {
    return (yield* database.$count(approvals, eq(approvals.runId, runId)).execute()) > 0;
  });

  const recordApproval = Effect.fn("RunStoreQueries.recordApproval")(function* (
    runId: RunId,
    approval: Event,
    source: ApprovalSource,
  ) {
    const payloadJson = yield* encodePayload(approval.payload);
    yield* database
      .insert(events)
      .values({
        eventId: approval.id,
        dedupKey: approval.dedupKey,
        payloadJson: payloadJson,
        receivedAt: encodeDateTime(approval.receivedAt),
      })
      .onConflictDoNothing()
      .execute();
    yield* database
      .insert(approvals)
      .values({
        runId,
        eventId: approval.id,
        channel: source.channel,
        approver: Option.getOrNull(source.approver),
      })
      .execute();
    yield* changedRun(runId);
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
    const stateJson = yield* encodeRunState(RunState.Pending.make());
    const agentJson = yield* encodeAgent(submission.agent);
    yield* database
      .insert(runs)
      .values({
        runId,
        eventId,
        loopName: submission.loop,
        stateJson: stateJson,
        openedAt: encodeDateTime(submission.event.receivedAt),
        repository: submission.repository,
        revision: submission.revision,
        task: submission.task,
        agentJson: agentJson,
      })
      .onConflictDoNothing()
      .execute();
    yield* database
      .insert(steps)
      .values({ runId, stepName: submission.step, result: null })
      .onConflictDoNothing()
      .execute();
    yield* changedRun(runId);
  });

  const blockingRun = Effect.fn("RunStoreQueries.blockingRun")(function* (
    loop: LoopName,
    itemKey: ItemKey,
  ) {
    const rows = yield* database
      .select({ runId: runs.runId })
      .from(runs)
      .innerJoin(triggerEvents, eq(triggerEvents.eventId, runs.eventId))
      .where(and(eq(triggerEvents.loopName, loop), eq(triggerEvents.itemKey, itemKey), openState))
      .orderBy(desc(runs.openedAt))
      .limit(1)
      .execute();
    return yield* decodeRunIds(rows);
  });

  const runIdsToDrive = Effect.fn("RunStoreQueries.runIdsToDrive")(function* () {
    const waiting: RunState.RunState["_tag"] = "Waiting";
    const rows = yield* database
      .select({ runId: runs.runId })
      .from(runs)
      .where(and(openState, ne(storedStateTag, waiting), ne(storedStateTag, "AwaitingCi")))
      .execute();

    return (yield* decodeRunIds(rows)).map(({ runId }) => runId);
  });

  const awaitingCiRuns = Effect.fn("RunStoreQueries.awaitingCiRuns")(function* () {
    const rows = yield* database
      .select({ runId: runs.runId })
      .from(runs)
      .where(sql`${storedStateTag} = 'AwaitingCi'`)
      .execute();
    return rows;
  });

  return {
    snapshot,
    createRun,
    updateState,
    nextStart,
    setNextStart,
    amend,
    updateStepResult,
    resolveFailure,
    recordApproval,
    approvalExists,
    blockingRun,
    runIdsToDrive,
    awaitingCiRuns,
  } as const;
};
