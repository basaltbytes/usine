import { RepositoryName } from "@usine/core/repository";
import { WorkerName } from "@usine/core/worker";
import type { Agent } from "@usine/core/agent";
import type { ModelId } from "@usine/core/agent/brain";
import {
  Attempt,
  AttemptId,
  AttemptContext,
  AttemptNumber,
  type ContainerOutOfMemoryKills,
  totalOutOfMemoryKills,
} from "@usine/core/attempt";

import { AttemptOutcome } from "@usine/core/attempt/outcome";
import { AttemptSalvage, salvageRefFor } from "@usine/core/attempt/salvage";
import type { OperatorRetryStart } from "@usine/core/attempt/start";
import { Event, DedupKey, EventId } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { LoopName, LoopPermissions } from "@usine/core/loop";
import { RunId } from "@usine/core/run";
import type { RunAgain } from "@usine/core/run/again";
import type { ApprovalSource } from "@usine/core/run/approval";
import { StepName } from "@usine/core/step";
import * as RunState from "@usine/core/run/state";
import { type Comment, StepResult } from "@usine/core/step/result";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  ne,
  notInArray,
  sql,
  type SQL,
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
  itemCycleBudgets,
  loopItems,
  projectionRevision,
  runAgainEvents,
  runs,
  steps,
  triggerEvents,
} from "../database/schema.ts";
import { RunNotFoundError } from "../engine/error.ts";
import { RunSnapshot, RunSummary } from "../run-reader/model.ts";
import { Submission } from "../engine/submission.ts";
import { cycleQueries } from "../cycle-budget/queries.ts";
import {
  type RunRow,
  approvalFromRow,
  attemptFromRow,
  decodeAttemptRows,
  decodeDiscards,
  decodeNextStarts,
  decodeOutOfMemory,
  decodeEventRoutes,
  decodeProjectionRevision,
  decodeReopenedEvents,
  decodeReopenings,
  decodeRunEventRows,
  decodeRunIds,
  decodeRunRows,
  encodeAgent,
  encodeAttemptStart,
  encodeBrainSpec,
  encodeDateTime,
  encodeOutcome,
  encodeComments,
  encodeOutOfMemory,
  encodeSalvage,
  encodePayload,
  encodeRunState,
  encodeStepResult,
  eventFromRow,
  runAgainFromRow,
  runEventFromRow,
  runFromRow,
  runSummaryFromRow,
  stepFromRow,
  submissionFromRow,
} from "./codec.ts";

import { loopItemQueries } from "./loop-items.ts";
import { transcriptQueries } from "./transcript.ts";

/** The newest queued submission and the Events read with it. */
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
  permissions: triggerEvents.permissions,
  cycleLimit: triggerEvents.cycleLimit,
  cycleGeneration: triggerEvents.cycleGeneration,
  repository: triggerEvents.repository,
  revision: triggerEvents.revision,
  task: triggerEvents.task,
  agent: triggerEvents.agentJson,
  parentModel: triggerEvents.parentModel,
} as const;

const approvalEvents = alias(events, "approval_event");

const runSelection = {
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
  parentModel: runs.parentModel,
  stepName: steps.stepName,
  result: steps.result,
  approvedAt: approvalEvents.receivedAt,
  approvalChannel: approvals.channel,
  approver: approvals.approver,
  againFrom: runAgainEvents.fromRunId,
  againRequestedBy: runAgainEvents.requestedBy,
} as const;

export const attemptSelection = {
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
  endedAt: attempts.endedAt,
  salvage: attempts.salvageJson,
  start: attempts.startJson,
  reattachedAt: attempts.reattachedAt,
  comments: attempts.commentsJson,
  outOfMemory: attempts.outOfMemoryJson,
} as const;

const storedStateTag = sql`json_extract(${runs.stateJson}, '$._tag')`;
const openState = inArray(storedStateTag, [...RunState.OPEN_STATE_TAGS]);
const unstartedState = inArray(storedStateTag, [...RunState.UNSTARTED_STATE_TAGS]);
// The Json round-trip gives `queriesFor` a portable named type; without it tsc
// cannot emit the declaration (TS2883).
const storedAgent = (agent: Agent): Schema.Json =>
  Schema.decodeUnknownSync(Schema.Json)(encodeAgent(agent));

export const queriesFor = (database: RunDatabaseClient) => {
  // `.execute()` stays explicit (ADR 0020).
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

  /** Returns the Attempts that match `filters` and whose leftovers weren't discarded. */
  const recoveries = (...filters: ReadonlyArray<SQL>) =>
    Effect.gen(function* () {
      const rows = yield* database
        .select({
          attemptId: attempts.attemptId,
          worker: attempts.workerName,
          repository: runs.repository,
          runId: attempts.runId,
          loop: triggerEvents.loopName,
          itemKey: triggerEvents.itemKey,
          number: attempts.attemptNumber,
          permissions: triggerEvents.permissions,
          outcome: sql<string>`coalesce(json_extract(${attempts.outcomeJson}, '$._tag'), '')`,
          salvage: attempts.salvageJson,
        })
        .from(attempts)
        .innerJoin(runs, eq(runs.runId, attempts.runId))
        .innerJoin(triggerEvents, eq(triggerEvents.eventId, runs.eventId))
        .where(and(isNull(attempts.leftoversDiscardedAt), ...filters))
        .execute();
      const decoded = yield* Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({
            attemptId: AttemptId,
            worker: WorkerName,
            repository: RepositoryName,
            runId: RunId,
            loop: LoopName,
            itemKey: ItemKey,
            number: AttemptNumber,
            permissions: LoopPermissions,
            outcome: Schema.String,
            salvage: Schema.NullOr(AttemptSalvage),
          }),
        ),
      )(rows);
      return decoded.map(({ number, outcome, salvage, ...attempt }) => ({
        ...attempt,
        ref: salvageRefFor(attempt.runId, number),
        succeeded: outcome === "Succeeded",
        open: outcome === "",
        rejected: salvage?._tag === "Rejected" ? Option.some(salvage) : Option.none(),
      }));
    });

  const salvageCandidates = Effect.fn("RunStoreQueries.salvageCandidates")(function* () {
    return yield* recoveries();
  });

  const salvageCandidate = Effect.fn("RunStoreQueries.salvageCandidate")(function* (
    attemptId: AttemptId,
  ) {
    yield* Effect.annotateCurrentSpan({ attemptId });
    return EffectArray.head(yield* recoveries(eq(attempts.attemptId, attemptId)));
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
      closedAt: Option.fromNullishOr(storedRun.closedAt),
      approval: approvalFromRow(storedRun),
      runAgain: runAgainFromRow(storedRun),
      repository: storedRun.repository,
      revision: storedRun.revision,
      task: storedRun.task,
      agent: storedRun.agent,
      parentModel: Option.fromNullishOr(storedRun.parentModel),
      permissions: route.permissions,
    });
  });

  const summariesWithAttempts = Effect.fn("RunStoreQueries.summariesWithAttempts")(function* (
    storedRuns: ReadonlyArray<RunRow>,
  ) {
    const runIds = storedRuns.map(({ runId }) => runId);
    // Chunks keep each read below the driver's bind-parameter limit.
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
        selectRuns()
          .where(inArray(triggerEvents.itemKey, keys))
          .execute()
          .pipe(Effect.flatMap(decodeRunRows)),
    ))
      .flat()
      .sort(newestRunFirst);
    return yield* summariesWithAttempts(storedRuns);
  });

  // Every open Run plus the newest `closedLimit` closed ones, so an old waiting Run stays listed.
  const runSummaries = Effect.fn("RunStoreQueries.runSummaries")(function* (closedLimit: number) {
    const [openRuns, closedRuns] = yield* Effect.all([
      selectRuns()
        .where(openState)
        .orderBy(desc(runs.openedAt), desc(runs.runId))
        .execute()
        .pipe(Effect.flatMap(decodeRunRows)),
      selectRuns()
        .where(notInArray(storedStateTag, [...RunState.OPEN_STATE_TAGS]))
        .orderBy(desc(runs.openedAt), desc(runs.runId))
        .limit(closedLimit)
        .execute()
        .pipe(Effect.flatMap(decodeRunRows)),
    ]);
    const storedRuns = [...openRuns, ...closedRuns].sort(newestRunFirst);
    return yield* summariesWithAttempts(storedRuns);
  });

  const runEvents = Effect.fn("RunStoreQueries.runEvents")(function* (
    runIds: ReadonlyArray<RunId>,
  ) {
    // Chunks keep each read below the driver's bind-parameter limit.
    const rows = yield* Effect.forEach(EffectArray.chunksOf([...new Set(runIds)], 100), (ids) =>
      database
        .select({
          runId: runs.runId,
          eventId: events.eventId,
          dedupKey: events.dedupKey,
          payload: events.payloadJson,
          receivedAt: events.receivedAt,
        })
        .from(runs)
        .innerJoin(events, eq(events.eventId, runs.eventId))
        .where(inArray(runs.runId, ids))
        .execute()
        .pipe(Effect.flatMap(decodeRunEventRows)),
    );
    return rows.flat().map(runEventFromRow);
  });

  const closedRunSummaries = Effect.fn("RunStoreQueries.closedRunSummaries")(function* (
    limit: number,
  ) {
    const closedRuns = yield* selectRuns()
      .where(notInArray(storedStateTag, [...RunState.OPEN_STATE_TAGS]))
      .orderBy(desc(runs.closedAt), desc(runs.runId))
      .limit(limit)
      .execute()
      .pipe(Effect.flatMap(decodeRunRows));
    return yield* summariesWithAttempts(closedRuns);
  });

  // Every closed Run with `closedAt` at or after `since`, or every closed Run for `None`.
  const closedRunSummariesSince = Effect.fn("RunStoreQueries.closedRunSummariesSince")(function* (
    since: Option.Option<DateTime.Utc>,
  ) {
    const closed = notInArray(storedStateTag, [...RunState.OPEN_STATE_TAGS]);
    const closedRuns = yield* selectRuns()
      .where(
        Option.match(since, {
          onNone: () => closed,
          onSome: (from) => and(closed, gte(runs.closedAt, encodeDateTime(from))),
        }),
      )
      .orderBy(desc(runs.closedAt), desc(runs.runId))
      .execute()
      .pipe(Effect.flatMap(decodeRunRows));
    return yield* summariesWithAttempts(closedRuns);
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

  // A closed state sets `closedAt` to `at` or now; an open state clears it.
  const updateState = Effect.fn("RunStoreQueries.updateState")(function* (
    runId: RunId,
    state: RunState.RunState,
    at?: DateTime.Utc,
  ) {
    const closedAt = RunState.isOpen(state) ? null : encodeDateTime(at ?? (yield* DateTime.now));
    const updated = yield* database
      .update(runs)
      .set({ stateJson: encodeRunState(state), closedAt })
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
        endedAt: null,
        salvageJson: null,
        startJson: Option.match(attempt.start, { onNone: () => null, onSome: encodeAttemptStart }),
      })
      .execute();
  });

  const recordReattach = Effect.fn("RunStoreQueries.recordReattach")(function* (
    attemptId: AttemptId,
    reattachedAt: DateTime.Utc,
  ) {
    yield* Effect.annotateCurrentSpan({ attemptId });
    yield* database
      .update(attempts)
      .set({ reattachedAt: encodeDateTime(reattachedAt) })
      .where(eq(attempts.attemptId, attemptId))
      .execute();
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
    yield* database
      .update(runs)
      .set({
        nextStartJson: Option.match(start, { onNone: () => null, onSome: encodeAttemptStart }),
      })
      .where(eq(runs.runId, runId))
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

  const recordComments = Effect.fn("RunStoreQueries.recordComments")(function* (
    attemptId: AttemptId,
    comments: ReadonlyArray<Comment>,
  ) {
    yield* Effect.annotateCurrentSpan({ attemptId, comments: comments.length });
    yield* database
      .update(attempts)
      .set({ commentsJson: encodeComments(comments) })
      .where(eq(attempts.attemptId, attemptId))
      .execute();
  });

  /**
   * Records the kills of one of the Attempt's containers, replacing an earlier record of the same
   * container, and returns the kills of all its containers.
   */
  const recordOutOfMemory = Effect.fn("RunStoreQueries.recordOutOfMemory")(function* (
    attemptId: AttemptId,
    kills: ContainerOutOfMemoryKills,
  ) {
    yield* Effect.annotateCurrentSpan({
      attemptId,
      container: kills.container,
      kills: kills.kills,
    });
    const rows = yield* database
      .select({ outOfMemory: attempts.outOfMemoryJson })
      .from(attempts)
      .where(eq(attempts.attemptId, attemptId))
      .execute();
    const recorded = (yield* decodeOutOfMemory(rows))[0]?.outOfMemory ?? [];
    const containers = EffectArray.append(
      recorded.filter(({ container }) => container !== kills.container),
      kills,
    );
    yield* database
      .update(attempts)
      .set({ outOfMemoryJson: encodeOutOfMemory(containers) })
      .where(eq(attempts.attemptId, attemptId))
      .execute();
    return totalOutOfMemoryKills(containers);
  });

  const closeAttempt = Effect.fn("RunStoreQueries.closeAttempt")(function* (
    attemptId: AttemptId,
    outcome: AttemptOutcome,
    endedAt: DateTime.Utc,
  ) {
    yield* database
      .update(attempts)
      .set({ outcomeJson: encodeOutcome(outcome), endedAt: encodeDateTime(endedAt) })
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
    source: ApprovalSource,
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
    yield* database
      .insert(approvals)
      .values({
        runId,
        eventId: approval.id,
        channel: source.channel,
        approver: Option.getOrNull(source.approver),
      })
      .execute();
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

  /** Returns the newest reopening of `eventId` (#267), with its reopening number. */
  const newestReopening = Effect.fn("RunStoreQueries.newestReopening")(function* (
    eventId: EventId,
  ) {
    const rows = yield* decodeReopenings(
      yield* database
        .select({ ...eventRouteSelection, reopening: triggerEvents.reopening })
        .from(events)
        .innerJoin(triggerEvents, eq(triggerEvents.eventId, events.eventId))
        .where(eq(triggerEvents.reopensEventId, eventId))
        .orderBy(desc(triggerEvents.reopening))
        .limit(1)
        .execute(),
    );
    return Option.map(Option.fromNullishOr(rows[0]), (row) => ({
      submission: submissionFromRow(row),
      reopening: row.reopening,
    }));
  });

  /** Returns the trigger Event that `eventId` reopens or runs again, or `None` for a trigger's own Event. */
  const reopenedEvent = Effect.fn("RunStoreQueries.reopenedEvent")(function* (eventId: EventId) {
    const reopened = alias(events, "reopened_event");
    const rows = yield* decodeReopenedEvents(
      yield* database
        .select({ eventId: reopened.eventId, dedupKey: reopened.dedupKey })
        .from(triggerEvents)
        .innerJoin(reopened, eq(reopened.eventId, triggerEvents.reopensEventId))
        .where(eq(triggerEvents.eventId, eventId))
        .execute(),
    );
    return Option.fromNullishOr(rows[0]);
  });

  /** Records that `eventId` came from running a closed Run again, and the requesting login. */
  const recordRunAgain = Effect.fn("RunStoreQueries.recordRunAgain")(function* (
    eventId: EventId,
    again: RunAgain,
  ) {
    yield* database
      .insert(runAgainEvents)
      .values({
        eventId,
        fromRunId: again.from,
        requestedBy: Option.getOrNull(again.requestedBy),
      })
      .execute();
  });

  /**
   * Records a trigger Event and its route once, and returns the route as first recorded.
   * `reopens` is the earlier Event that this one reopens.
   */
  const recordTriggerEvent = Effect.fn("RunStoreQueries.recordTriggerEvent")(function* (
    submission: Submission,
    reopens: Option.Option<{
      readonly eventId: EventId;
      readonly reopening: number;
    }> = Option.none(),
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
          permissions: submission.permissions,
          cycleLimit: Option.getOrNull(submission.cycleLimit),
          cycleGeneration: submission.cycleGeneration,
          repository: submission.repository,
          revision: submission.revision,
          task: submission.task,
          agentJson: storedAgent(submission.agent),
          parentModel: Option.getOrNull(submission.parentModel),
          reopensEventId: Option.getOrNull(Option.map(reopens, ({ eventId }) => eventId)),
          reopening: Option.match(reopens, {
            onNone: () => 0,
            onSome: ({ reopening }) => reopening,
          }),
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
    const suppression = yield* loopItemQueries(database).suppression(current.loop, current.itemKey);
    if (Option.isSome(suppression)) {
      yield* Effect.logInfo("Queued Events wait while a suppression keeps the Item", {
        runId,
        suppressedBy: suppression.value.runId,
        loop: current.loop,
        itemKey: current.itemKey,
      });
      return Option.none<QueuedEvents>();
    }
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

  const runIdsToDrive = Effect.fn("RunStoreQueries.runIdsToDrive")(function* () {
    const waiting: RunState.RunState["_tag"] = "Waiting";
    const rows = yield* database
      .select({ runId: runs.runId })
      .from(runs)
      .where(and(openState, ne(storedStateTag, waiting)))
      .execute();
    return (yield* decodeRunIds(rows)).map(({ runId }) => runId);
  });

  // The newest closed Run of each Item that has a current queued Event and no open Run, excluding
  // Items waiting for a cycle-budget reset or under a suppression.
  const pendingContinuations = Effect.fn("RunStoreQueries.pendingContinuations")(function* () {
    const items = yield* database
      .selectDistinct({ loop: triggerEvents.loopName, itemKey: triggerEvents.itemKey })
      .from(triggerEvents)
      .leftJoin(runs, eq(runs.eventId, triggerEvents.eventId))
      .leftJoin(ignoredEvents, eq(ignoredEvents.eventId, triggerEvents.eventId))
      .leftJoin(itemCycleBudgets, eq(itemCycleBudgets.itemKey, triggerEvents.itemKey))
      .leftJoin(
        loopItems,
        and(
          eq(loopItems.loopName, triggerEvents.loopName),
          eq(loopItems.itemKey, triggerEvents.itemKey),
        ),
      )
      .where(
        and(
          isNull(runs.runId),
          isNull(ignoredEvents.eventId),
          isNull(itemCycleBudgets.askJson),
          isNull(loopItems.suppressedByRunId),
          cycleQueries(database).currentEvent,
        ),
      )
      .execute();
    const decoded = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ loop: LoopName, itemKey: ItemKey })),
    )(items);
    const closed = yield* Effect.forEach(decoded, ({ loop, itemKey }) =>
      Effect.gen(function* () {
        if ((yield* blockingRun(loop, itemKey)).length > 0) return [];
        return yield* decodeRunIds(
          yield* database
            .select({ runId: runs.runId })
            .from(runs)
            .innerJoin(triggerEvents, eq(triggerEvents.eventId, runs.eventId))
            .where(and(eq(triggerEvents.loopName, loop), eq(triggerEvents.itemKey, itemKey)))
            .orderBy(desc(runs.openedAt), desc(runs.runId))
            .limit(1)
            .execute(),
        );
      }),
    );
    return closed.flat().map(({ runId }) => runId);
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
    salvageCandidate,
    cycles: cycleQueries(database),
    loopItems: loopItemQueries(database),
    ...transcriptQueries(database),
    addAttempt,
    recordReattach,
    nextStart,
    setNextStart,
    recordSalvage,
    recordComments,
    recordOutOfMemory,
    amend,
    markIntervened,
    approvalExists,
    blockingRun,
    closeAttempt,
    createRun,
    eventRouteByRun,
    ignoredEvent,
    newestReopening,
    nextQueued,
    reopenedEvent,
    recordRunAgain,
    pendingContinuations,
    recordTriggerEvent,
    runIdsToDrive,
    recordApproval,
    revision,
    revokeQueued,
    revokeUnstarted,
    runSummaries,
    closedRunSummaries,
    closedRunSummariesSince,
    itemRunSummaries,
    runEvents,
    runForEvent,
    snapshot,
    updateStepResult,
    updateAttemptParentModel,
    updateState,
    resolveFailure,
  } as const;
};
