import type { RecordChange } from "./changes.ts";
import { CiPolicy } from "@usine/core/ci";
import { RepositoryName, canonicalRepositoryName } from "@usine/core/repository";
import { WorkerName } from "@usine/core/worker";
import type { ModelId } from "@usine/core/agent/brain";
import {
  Attempt,
  AttemptId,
  AttemptContext,
  AttemptNumber,
  type ContainerOutOfMemoryKills,
  type FailureResolution,
  totalOutOfMemoryKills,
} from "@usine/core/attempt";

import { AttemptFailed, AttemptOutcome } from "@usine/core/attempt/outcome";
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
  isNotNull,
  ne,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { Array as EffectArray, DateTime, Effect, Option, Schema, Struct } from "effect";
import { jsonArrayValues, jsonExtract, jsonObject, isTrue } from "../database/dialect.ts";
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
import { BoardRunHistory, RunSnapshot, RunSummary } from "../run-reader/model.ts";
import { type RevokeScope, Submission } from "../engine/submission.ts";
import { cycleQueries } from "../cycle-budget/queries.ts";
import {
  type RunSummaryRow,
  decodeRunSummaryRows,
  decodeAttemptSummaryRows,
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
  encodeFailureResolution,
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

import { boardHistoryQueries, runPullRequestUrl } from "./board.ts";
import { loopItemQueries } from "./loop-items.ts";
import type { TranscriptCodec } from "./transcript/codec.ts";
import { transcriptQueries } from "./transcript/queries.ts";

/** The newest queued submission and the Events read with it. */
export interface QueuedEvents {
  readonly submission: Submission;
  readonly eventIds: ReadonlyArray<EventId>;
}

const newestRunFirst = (left: RunSummaryRow, right: RunSummaryRow) =>
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
  approvalReason: triggerEvents.approvalReason,
  permissions: triggerEvents.permissions,
  ciPolicy: triggerEvents.ciPolicyJson,
  ciFailureHead: triggerEvents.ciFailureHead,
  ciOnGreen: triggerEvents.ciOnGreenJson,
  outcomeLabels: triggerEvents.outcomeLabelsJson,
  cycleLimit: triggerEvents.cycleLimit,
  cycleGeneration: triggerEvents.cycleGeneration,
  repository: triggerEvents.repository,
  revision: triggerEvents.revision,
  task: triggerEvents.task,
  agent: triggerEvents.agentJson,
  parentModel: triggerEvents.parentModel,
} as const;

/** The trigger Event columns that hold the Loop's settings when the Event matched. */
const loopSettingColumns = Effect.fnUntraced(function* (submission: Submission) {
  const ciPolicyJson = yield* Option.match(submission.ciPolicy, {
    onNone: () => Effect.succeed(null),
    onSome: Schema.encodeEffect(CiPolicy),
  }).pipe(Effect.orDie);
  return {
    approval: submission.approval,
    approvalReason: Option.getOrNull(submission.approvalReason),
    permissions: submission.permissions,
    ciPolicyJson,
    outcomeLabelsJson: [...submission.outcomeLabels],
    cycleLimit: Option.getOrNull(submission.cycleLimit),
    agentJson: yield* encodeAgent(submission.agent),
    parentModel: Option.getOrNull(submission.parentModel),
  };
});

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
  approvalReason: triggerEvents.approvalReason,
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
  result: attempts.resultJson,
  endedAt: attempts.endedAt,
  salvage: attempts.salvageJson,
  start: attempts.startJson,
  failureResolution: attempts.failureResolutionJson,
  reattachedAt: attempts.reattachedAt,
  comments: attempts.commentsJson,
  outOfMemory: attempts.outOfMemoryJson,
} as const;

const runSummarySelection = {
  ...Struct.omit(runSelection, ["task", "result", "revision", "parentModel", "stepName", "agent"]),
  agent: jsonObject([
    ["name", jsonExtract(runs.agentJson, "$.name")],
    ["brain", jsonExtract(runs.agentJson, "$.brain")],
  ]).mapWith(runs.agentJson),
  pullRequestUrl: runPullRequestUrl,
} as const;

const attemptSummarySelection = Struct.omit(attemptSelection, ["task", "comments", "result"]);

const storedStateTag = jsonExtract(runs.stateJson, "$._tag");
const openState = inArray(storedStateTag, [...RunState.OPEN_STATE_TAGS]);
const unstartedState = inArray(storedStateTag, [...RunState.UNSTARTED_STATE_TAGS]);
export const queriesFor = (
  database: RunDatabaseClient,
  codec: TranscriptCodec["Service"],
  record?: RecordChange,
) => {
  const changedRun = (runId: RunId) =>
    Effect.gen(function* () {
      if (record === undefined) return;
      const [row] = yield* database
        .select({ repository: runs.repository, itemKey: triggerEvents.itemKey })
        .from(runs)
        .innerJoin(triggerEvents, eq(triggerEvents.eventId, runs.eventId))
        .where(eq(runs.runId, runId))
        .execute();
      if (row === undefined) return;
      const audience = { _tag: "Repository", repository: row.repository } as const;
      yield* record({ audience, target: { kind: "run", id: runId } });
      yield* record({ audience, target: { kind: "item", id: row.itemKey } });
    });
  const changedAttempt = (attemptId: AttemptId) =>
    Effect.gen(function* () {
      if (record === undefined) return;
      const [row] = yield* database
        .select({ repository: runs.repository, runId: runs.runId })
        .from(attempts)
        .innerJoin(runs, eq(runs.runId, attempts.runId))
        .where(eq(attempts.attemptId, attemptId))
        .execute();
      if (row === undefined) return;
      yield* record({
        audience: { _tag: "Repository", repository: row.repository },
        target: { kind: "attempt", id: attemptId },
      });
      yield* changedRun(row.runId);
    });
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

  const selectRunSummaries = () =>
    database
      .select(runSummarySelection)
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
          outcome: sql<string>`coalesce(${jsonExtract(attempts.outcomeJson, "$._tag")}, '')`,
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
        succeeded: outcome === "Succeeded" || outcome === "AwaitingCi" || outcome === "HandedOff",
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
    const recoveryRows = yield* recoveries(eq(attempts.attemptId, attemptId));
    return EffectArray.head(recoveryRows);
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
      parentModel: Option.fromNullishOr(storedRun.parentModel),
      permissions: route.permissions,
      ciPolicy: Option.fromNullishOr(route.ciPolicy),
    });
  });

  const summariesWithAttempts = Effect.fn("RunStoreQueries.summariesWithAttempts")(function* (
    storedRuns: ReadonlyArray<RunSummaryRow>,
  ) {
    const runIds = storedRuns.map(({ runId }) => runId);
    // Chunks keep each read below the driver's bind-parameter limit.

    const storedAttempts = (yield* Effect.forEach(EffectArray.chunksOf(runIds, 100), (ids) =>
      database
        .select(attemptSummarySelection)
        .from(attempts)
        .where(inArray(attempts.runId, ids))
        .orderBy(asc(attempts.runId), asc(attempts.attemptNumber))
        .execute()
        .pipe(Effect.flatMap(decodeAttemptSummaryRows)),
    )).flat();
    const attemptsByRun = EffectArray.groupBy(storedAttempts, ({ runId }) => runId);
    return storedRuns.map((row): RunSummary =>
      runSummaryFromRow(row, attemptsByRun[row.runId] ?? []),
    );
  });

  const runSummary = Effect.fn("RunStoreQueries.runSummary")(function* (runId: RunId) {
    yield* Effect.annotateCurrentSpan({ runId });
    const rows = yield* selectRunSummaries()
      .where(eq(runs.runId, runId))
      .limit(1)
      .execute()
      .pipe(Effect.flatMap(decodeRunSummaryRows));
    const [summary] = yield* summariesWithAttempts(rows);
    if (summary === undefined) return yield* RunNotFoundError.make({ runId });
    return summary;
  });

  const itemRunSummaries = Effect.fn("RunStoreQueries.itemRunSummaries")(function* (
    itemKeys: ReadonlyArray<ItemKey>,
  ) {
    if (itemKeys.length === 0) return [];

    const storedRuns = (yield* Effect.forEach(
      EffectArray.chunksOf([...new Set(itemKeys)], 100),
      (keys) =>
        selectRunSummaries()
          .where(inArray(triggerEvents.itemKey, keys))
          .execute()
          .pipe(Effect.flatMap(decodeRunSummaryRows)),
    ))
      .flat()
      .sort(newestRunFirst);
    return yield* summariesWithAttempts(storedRuns);
  });

  const boardRunSummaries = Effect.fn("RunStoreQueries.boardRunSummaries")(function* (
    itemKeys: ReadonlyArray<ItemKey>,
    attentionRunIds: ReadonlyArray<RunId>,
  ) {
    yield* Effect.annotateCurrentSpan({ itemKeys, attentionRunIds });
    const items = yield* boardHistoryQueries(database).itemHistory(itemKeys);

    const storedRuns = (yield* Effect.forEach(
      EffectArray.chunksOf([...new Set(itemKeys)], 100),
      (keys) => {
        const ranked = database
          .select({
            runId: runs.runId,
            state: runs.stateJson,
            resolved: runs.resolvedFailureAttemptId,
            latestAttempt: sql<
              string | null
            >`(select ${attempts.attemptId} from ${attempts} where ${attempts.runId} = ${runs.runId} order by ${attempts.attemptNumber} desc limit 1)`.as(
              "latest_attempt",
            ),
            rank: sql<number>`row_number() over (partition by ${triggerEvents.itemKey} order by ${runs.openedAt} desc, ${runs.runId} desc)`.as(
              "rank",
            ),
          })
          .from(runs)
          .innerJoin(triggerEvents, eq(triggerEvents.eventId, runs.eventId))
          .where(sql`${triggerEvents.itemKey} in (${jsonArrayValues(keys)})`)
          .as("board_current_runs");
        const state = jsonExtract(ranked.state, "$._tag");
        const current = () =>
          database
            .select({ runId: ranked.runId })
            .from(ranked)
            .where(
              or(
                eq(ranked.rank, 1),
                inArray(state, [...RunState.OPEN_STATE_TAGS]),
                and(
                  eq(state, "Failed"),
                  or(isNull(ranked.resolved), ne(ranked.resolved, ranked.latestAttempt)),
                ),
                sql`${ranked.runId} in (${jsonArrayValues(attentionRunIds)})`,
              ),
            );
        const selectedRuns = current().unionAll(
          database
            .select({ runId: runs.runId })
            .from(runs)
            .where(
              inArray(sql`cast(${jsonExtract(runs.stateJson, "$.fixRunId")} as text)`, current()),
            ),
        );
        return selectRunSummaries()
          .where(inArray(runs.runId, selectedRuns))
          .orderBy(desc(runs.openedAt), desc(runs.runId))
          .execute()
          .pipe(Effect.flatMap(decodeRunSummaryRows));
      },
    ))
      .flat()
      .sort(newestRunFirst);
    const uniqueRuns = [...new Map(storedRuns.map((run) => [run.runId, run])).values()];
    const summaries = yield* summariesWithAttempts(uniqueRuns);
    yield* Effect.logDebug("Read current board runs", {
      items: items.length,
      runs: summaries.length,
    });
    return BoardRunHistory.make({ items, runs: summaries });
  });

  // Every open Run plus the newest `closedLimit` closed ones, so an old waiting Run stays listed.
  const runSummaries = Effect.fn("RunStoreQueries.runSummaries")(function* (closedLimit: number) {
    const [openRuns, closedRuns] = yield* Effect.all([
      selectRunSummaries()
        .where(openState)
        .orderBy(desc(runs.openedAt), desc(runs.runId))
        .execute()
        .pipe(Effect.flatMap(decodeRunSummaryRows)),
      selectRunSummaries()
        .where(isTrue(sql`${runs.closedAt} is not null`))
        .orderBy(desc(runs.openedAt), desc(runs.runId))
        .limit(closedLimit)
        .execute()
        .pipe(Effect.flatMap(decodeRunSummaryRows)),
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
    repositories?: ReadonlyArray<RepositoryName>,
  ) {
    const closedRuns = yield* selectRunSummaries()
      .where(
        and(
          isNotNull(runs.closedAt),
          repositories === undefined
            ? undefined
            : sql`lower(${runs.repository}) in (${jsonArrayValues(repositories.map(canonicalRepositoryName))})`,
        ),
      )
      .orderBy(desc(runs.closedAt), desc(runs.runId))
      .limit(limit)
      .execute()
      .pipe(Effect.flatMap(decodeRunSummaryRows));
    return yield* summariesWithAttempts(closedRuns);
  });

  // Every closed Run with `closedAt` at or after `since`, or every closed Run for `None`.
  const closedRunSummariesSince = Effect.fn("RunStoreQueries.closedRunSummariesSince")(function* (
    since: Option.Option<DateTime.Utc>,
  ) {
    const closed = isNotNull(runs.closedAt);
    const closedRuns = yield* selectRunSummaries()
      .where(
        Option.match(since, {
          onNone: () => closed,
          onSome: (from) => and(closed, gte(runs.closedAt, encodeDateTime(from))),
        }),
      )
      .orderBy(desc(runs.closedAt), desc(runs.runId))
      .execute()
      .pipe(Effect.flatMap(decodeRunSummaryRows));
    return yield* summariesWithAttempts(closedRuns);
  });

  const revision = Effect.fn("RunStoreQueries.projectionRevision")(function* () {
    const storedRows = yield* database
      .select({ revision: projectionRevision.revision })
      .from(projectionRevision)
      .where(eq(projectionRevision.singleton, 1))
      .limit(1)
      .execute();
    const rows = yield* decodeProjectionRevision(storedRows);
    return Option.fromNullishOr(rows[0]?.revision);
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

  const addAttempt = Effect.fn("RunStoreQueries.addAttempt")(function* (attempt: Attempt) {
    const brainJson = yield* encodeBrainSpec(attempt.brain);
    const startJson = yield* Option.match(attempt.start, {
      onNone: () => Effect.succeed(null),
      onSome: encodeAttemptStart,
    });
    yield* database
      .insert(attempts)
      .values({
        attemptId: attempt.id,
        runId: attempt.runId,
        stepName: attempt.stepName,
        workerName: attempt.worker,
        attemptNumber: attempt.number,
        brainJson: brainJson,
        task: attempt.task,
        agent: attempt.agent,
        operatorIntervened: attempt.operatorIntervened,
        parentModel: Option.getOrNull(attempt.parentModel),
        startedAt: encodeDateTime(attempt.startedAt),
        outcomeJson: null,
        endedAt: null,
        salvageJson: null,
        startJson: startJson,
      })
      .execute();
    yield* changedAttempt(attempt.id);
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

  const recordSalvage = Effect.fn("RunStoreQueries.recordSalvage")(function* (
    attemptId: AttemptId,
    salvage: AttemptSalvage,
  ) {
    yield* Effect.annotateCurrentSpan({ attemptId, salvage: salvage._tag });
    const salvageJson = yield* encodeSalvage(salvage);
    yield* database
      .update(attempts)
      .set({ salvageJson: salvageJson })
      .where(eq(attempts.attemptId, attemptId))
      .execute();
    if (salvage._tag === "Retained" && Option.isSome(salvage.pushFailure))
      yield* database
        .update(attempts)
        .set({
          outcomeJson: yield* encodeOutcome(
            AttemptFailed.make({ failure: salvage.pushFailure.value }),
          ),
        })
        .where(
          and(
            eq(attempts.attemptId, attemptId),
            sql`${jsonExtract(attempts.outcomeJson, "$._tag")} = 'Failed'`,
            sql`${jsonExtract(attempts.outcomeJson, "$.failure._tag")} != 'GitHubPushFailure'`,
          ),
        )
        .execute();
    yield* changedAttempt(attemptId);
  });

  const recordComments = Effect.fn("RunStoreQueries.recordComments")(function* (
    attemptId: AttemptId,
    comments: ReadonlyArray<Comment>,
  ) {
    yield* Effect.annotateCurrentSpan({ attemptId, comments: comments.length });
    const commentsJson = yield* encodeComments(comments);
    yield* database
      .update(attempts)
      .set({ commentsJson: commentsJson })
      .where(eq(attempts.attemptId, attemptId))
      .execute();
    yield* changedAttempt(attemptId);
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
    const outOfMemoryJson = yield* encodeOutOfMemory(containers);
    yield* database
      .update(attempts)
      .set({ outOfMemoryJson: outOfMemoryJson })
      .where(eq(attempts.attemptId, attemptId))
      .execute();

    yield* changedAttempt(attemptId);
    return totalOutOfMemoryKills(containers);
  });

  const closeAttempt = Effect.fn("RunStoreQueries.closeAttempt")(function* (
    attemptId: AttemptId,
    outcome: AttemptOutcome,
    endedAt: DateTime.Utc,
  ) {
    const outcomeJson = yield* encodeOutcome(outcome);
    yield* database
      .update(attempts)
      .set({ outcomeJson: outcomeJson, endedAt: encodeDateTime(endedAt) })
      .where(and(eq(attempts.attemptId, attemptId), isNull(attempts.outcomeJson)))
      .execute();
    yield* changedAttempt(attemptId);
  });

  const settleCiAttempt = Effect.fn("RunStoreQueries.settleCiAttempt")(function* (
    runId: RunId,
    outcome: AttemptOutcome,
  ) {
    const outcomeJson = yield* encodeOutcome(outcome);
    yield* database
      .update(attempts)
      .set({ outcomeJson: outcomeJson })
      .where(
        and(
          eq(attempts.runId, runId),
          sql`${jsonExtract(attempts.outcomeJson, "$._tag")} = 'AwaitingCi'`,
        ),
      )
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
        parentModel: Option.getOrNull(context.parentModel),
      })
      .where(eq(runs.runId, runId))
      .execute();
    yield* changedRun(runId);
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
    yield* changedAttempt(attemptId);
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
    yield* changedAttempt(attemptId);
  });

  const recordAttemptResult = Effect.fn("RunStoreQueries.recordAttemptResult")(function* (
    attemptId: AttemptId,
    result: StepResult,
  ) {
    yield* Effect.annotateCurrentSpan({ attemptId });
    const resultJson = yield* encodeStepResult(result);
    yield* database
      .update(attempts)
      .set({ resultJson })
      .where(eq(attempts.attemptId, attemptId))
      .execute();
    yield* changedAttempt(attemptId);
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
        parentModel: Option.getOrNull(submission.parentModel),
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

  const runForEvent = Effect.fn("RunStoreQueries.runForEvent")(function* (eventId: EventId) {
    const rows = yield* database
      .select({ runId: runs.runId })
      .from(runs)
      .where(eq(runs.eventId, eventId))
      .execute();
    return yield* decodeRunIds(rows);
  });

  const ignoredEvent = Effect.fn("RunStoreQueries.ignoredEvent")(function* (eventId: EventId) {
    const rows = yield* database
      .select({ reason: ignoredEvents.reason })
      .from(ignoredEvents)
      .where(eq(ignoredEvents.eventId, eventId))
      .execute();
    return yield* decodeDiscards(rows);
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

  /** Returns the newest reopening of `eventId` (#267), with its reopening number. */
  const newestReopening = Effect.fn("RunStoreQueries.newestReopening")(function* (
    eventId: EventId,
  ) {
    const storedRows = yield* database
      .select({ ...eventRouteSelection, reopening: triggerEvents.reopening })
      .from(events)
      .innerJoin(triggerEvents, eq(triggerEvents.eventId, events.eventId))
      .where(eq(triggerEvents.reopensEventId, eventId))
      .orderBy(desc(triggerEvents.reopening))
      .limit(1)
      .execute();
    const rows = yield* decodeReopenings(storedRows);
    return Option.map(Option.fromNullishOr(rows[0]), (row) => ({
      submission: submissionFromRow(row),
      reopening: row.reopening,
    }));
  });

  /** Returns the trigger Event that `eventId` reopens or runs again, or `None` for a trigger's own Event. */
  const reopenedEvent = Effect.fn("RunStoreQueries.reopenedEvent")(function* (eventId: EventId) {
    const reopened = alias(events, "reopened_event");
    const storedRows = yield* database
      .select({ eventId: reopened.eventId, dedupKey: reopened.dedupKey })
      .from(triggerEvents)
      .innerJoin(reopened, eq(reopened.eventId, triggerEvents.reopensEventId))
      .where(eq(triggerEvents.eventId, eventId))
      .execute();
    const rows = yield* decodeReopenedEvents(storedRows);
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
    const payloadJson = yield* encodePayload(submission.event.payload);
    yield* database
      .insert(events)
      .values({
        eventId: submission.event.id,
        dedupKey: submission.event.dedupKey,
        payloadJson: payloadJson,
        receivedAt: encodeDateTime(submission.event.receivedAt),
      })
      .onConflictDoNothing()
      .execute();
    const routes = yield* eventRouteByDedup(submission.event.dedupKey);
    const existing = routes[0];
    if (existing === undefined) {
      const ciOnGreenJson = yield* Schema.encodeEffect(Submission.fields.ciOnGreen)(
        submission.ciOnGreen,
      ).pipe(Effect.orDie);
      const settings = yield* loopSettingColumns(submission);
      yield* database
        .insert(triggerEvents)
        .values({
          eventId: submission.event.id,
          itemKey: submission.itemKey,
          loopName: submission.loop,
          stepName: submission.step,
          ...settings,
          ciFailureHead: Option.getOrNull(submission.ciFailureHead),
          ciOnGreenJson: ciOnGreenJson,
          cycleGeneration: submission.cycleGeneration,
          repository: submission.repository,
          revision: submission.revision,
          task: submission.task,
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

  /**
   * Returns the current unclaimed Events of a Loop's Item, newest first, with the newest as the
   * submission to recheck. Every admission path starts with the newest Event, CI fix or trigger match.
   */
  const queuedOn = Effect.fn("RunStoreQueries.queuedOn")(function* (
    loop: LoopName,
    itemKey: ItemKey,
  ) {
    const queuedRows = yield* database
      .select(eventRouteSelection)
      .from(events)
      .innerJoin(triggerEvents, eq(triggerEvents.eventId, events.eventId))
      .leftJoin(runs, eq(runs.eventId, events.eventId))
      .leftJoin(ignoredEvents, eq(ignoredEvents.eventId, events.eventId))
      .where(
        and(
          eq(triggerEvents.loopName, loop),
          eq(triggerEvents.itemKey, itemKey),
          cycleQueries(database, record).currentEvent,
          isNull(runs.runId),
          isNull(ignoredEvents.eventId),
        ),
      )
      .orderBy(desc(events.receivedAt), desc(events.eventId))
      .execute();
    const queued = yield* decodeEventRoutes(queuedRows);
    return Option.fromNullishOr(queued[0]).pipe(
      Option.map((newest): QueuedEvents => ({
        submission: submissionFromRow(newest),
        eventIds: queued.map((row) => row.eventId),
      })),
    );
  });

  /**
   * Returns the Loops' Items with a current queued Event and no open Run, excluding Items waiting
   * for a cycle-budget reset or under a suppression. `ciFix` limits the Items to those with a
   * queued CI fix.
   */
  const admissibleItems = Effect.fn("RunStoreQueries.admissibleItems")(function* (ciFix: boolean) {
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
          ciFix ? isNotNull(triggerEvents.ciFailureHead) : undefined,
          isNull(runs.runId),
          isNull(ignoredEvents.eventId),
          isNull(itemCycleBudgets.askJson),
          isNull(loopItems.suppressedByRunId),
          cycleQueries(database, record).currentEvent,
        ),
      )
      .execute();
    const decoded = yield* Schema.decodeEffect(
      Schema.Array(Schema.Struct({ loop: LoopName, itemKey: ItemKey })),
    )(items);
    const unblocked = yield* Effect.forEach(decoded, (item) =>
      blockingRun(item.loop, item.itemKey).pipe(
        Effect.map((blocking) => (blocking.length === 0 ? [item] : [])),
      ),
    );
    return unblocked.flat();
  });

  // The queues whose newest Event is a CI fix; `pendingContinuations` takes the others.
  const pendingCiFixes = Effect.fn("RunStoreQueries.pendingCiFixes")(function* () {
    const items = yield* admissibleItems(true);
    const queues = yield* Effect.forEach(items, ({ loop, itemKey }) => queuedOn(loop, itemKey));
    return queues.flatMap((queued) =>
      Option.isSome(queued) && Option.isSome(queued.value.submission.ciFailureHead)
        ? [queued.value]
        : [],
    );
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
    return yield* queuedOn(current.loop, current.itemKey);
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

  // The newest closed Run of each queue whose newest Event is a trigger match; `pendingCiFixes`
  // takes the queues whose newest Event is a CI fix.
  const pendingContinuations = Effect.fn("RunStoreQueries.pendingContinuations")(function* () {
    const items = yield* admissibleItems(false);
    const closed = yield* Effect.forEach(items, ({ loop, itemKey }) =>
      Effect.gen(function* () {
        const queued = yield* queuedOn(loop, itemKey);
        if (Option.isNone(queued) || Option.isSome(queued.value.submission.ciFailureHead))
          return [];
        const rows = yield* database
          .select({ runId: runs.runId })
          .from(runs)
          .innerJoin(triggerEvents, eq(triggerEvents.eventId, runs.eventId))
          .where(and(eq(triggerEvents.loopName, loop), eq(triggerEvents.itemKey, itemKey)))
          .orderBy(desc(runs.openedAt), desc(runs.runId))
          .limit(1)
          .execute();
        return yield* decodeRunIds(rows);
      }),
    );
    return closed.flat().map(({ runId }) => runId);
  });

  /**
   * Replaces the Loop settings saved with a queued Event by `submission`'s: approval, permissions,
   * CI policy and task suffix, outcome labels, cycle limit, Agent, and parent model.
   */
  const recordSettings = Effect.fn("RunStoreQueries.recordSettings")(function* (
    submission: Submission,
  ) {
    const settings = yield* loopSettingColumns(submission);
    yield* database
      .update(triggerEvents)
      .set({ ...settings, task: submission.task })
      .where(eq(triggerEvents.eventId, submission.event.id))
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
    scope: RevokeScope,
  ) {
    const revokedHead =
      scope === "all"
        ? undefined
        : or(
            isNull(triggerEvents.ciFailureHead),
            ne(triggerEvents.ciFailureHead, scope.openCiHead),
          );
    const storedRows = yield* database
      .select({ runId: runs.runId })
      .from(runs)
      .innerJoin(triggerEvents, eq(triggerEvents.eventId, runs.eventId))
      .where(
        and(
          eq(triggerEvents.loopName, loop),
          eq(triggerEvents.itemKey, itemKey),
          revokedHead,
          unstartedState,
        ),
      )
      .execute();
    const rows = yield* decodeRunIds(storedRows);
    const queued = database
      .select({ eventId: triggerEvents.eventId })
      .from(triggerEvents)
      .where(
        and(eq(triggerEvents.loopName, loop), eq(triggerEvents.itemKey, itemKey), revokedHead),
      );
    yield* revokeQueued(loop, itemKey, queued);
    return rows;
  });

  return {
    changedAttempt,
    salvageCandidates,
    salvageCandidate,
    cycles: cycleQueries(database, record),
    loopItems: loopItemQueries(database),
    ...transcriptQueries(database, codec),
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
    settleCiAttempt,
    createRun,
    eventRouteByRun,
    ignoredEvent,
    newestReopening,
    nextQueued,
    queuedOn,
    reopenedEvent,
    recordRunAgain,
    pendingContinuations,
    pendingCiFixes,
    recordSettings,
    recordTriggerEvent,
    runIdsToDrive,
    recordApproval,
    revision,
    revokeQueued,
    revokeUnstarted,
    runSummary,
    runSummaries,
    closedRunSummaries,
    closedRunSummariesSince,
    itemRunSummaries,
    boardRunSummaries,
    runEvents,
    runForEvent,
    snapshot,
    recordAttemptResult,
    updateStepResult,
    updateAttemptParentModel,
    updateState,
    resolveFailure,
  } as const;
};
