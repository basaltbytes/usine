import type { RecordChange } from "../changes.ts";
import { changeRecorder } from "../changes.ts";
import { RepositoryName } from "@usine/core/repository";
import { WorkerName } from "@usine/core/worker";
import type { ModelId } from "@usine/core/agent/brain";
import {
  type Attempt,
  AttemptId,
  AttemptNumber,
  AttemptWindows,
  type ContainerOutOfMemoryKills,
  totalOutOfMemoryKills,
  windowOf,
  windowsOverlap,
} from "@usine/core/attempt";
import { AttemptFailed, type AttemptOutcome } from "@usine/core/attempt/outcome";
import { AttemptSalvage, salvageRefFor } from "@usine/core/attempt/salvage";
import { ItemKey } from "@usine/core/item";
import { LoopName, LoopPermissions } from "@usine/core/loop";
import { RunId } from "@usine/core/run";
import type { Comment, StepResult } from "@usine/core/step/result";
import { and, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import { Array as EffectArray, type DateTime, Effect, Option, Schema } from "effect";
import { jsonExtract } from "../../database/dialect.ts";
import type { RunDatabaseClient } from "../../database/database.ts";
import { attempts, runs, triggerEvents } from "../../database/schema.ts";
import {
  attemptFromRow,
  decodeAttemptRows,
  decodeOutOfMemory,
  encodeAttemptStart,
  encodeBrainSpec,
  encodeComments,
  encodeDateTime,
  encodeOutcome,
  encodeOutOfMemory,
  encodeSalvage,
  encodeStepResult,
} from "../codec.ts";

export const attemptSelection = {
  attemptId: attempts.attemptId,
  runId: attempts.runId,
  stepName: attempts.stepName,
  worker: attempts.workerName,
  workerKind: attempts.workerKind,
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

/** Returns the Attempt row queries that run on the caller's transaction. */
export const attemptQueries = (database: RunDatabaseClient, record?: RecordChange) => {
  const { changedRun, changedAttempt } = changeRecorder(database, record);

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
        // A success whose salvage didn't push all its work keeps its checkout for recovery to salvage.
        succeeded:
          (outcome === "Succeeded" || outcome === "AwaitingCi" || outcome === "HandedOff") &&
          (salvage === null || salvage._tag === "Pushed"),
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

  /**
   * Returns the window of `attemptId` and the overlapping windows of the same Agent's other
   * Attempts on the Item. An Attempt that ended before end times were recorded has no window: for
   * `attemptId` the result is empty, and other such Attempts are left out. Dies if `attemptId`
   * isn't recorded.
   */
  const attemptWindows = Effect.fn("RunStoreQueries.attemptWindows")(function* (
    attemptId: AttemptId,
  ) {
    yield* Effect.annotateCurrentSpan({ attemptId });
    const [own] = yield* database
      .select(attemptSelection)
      .from(attempts)
      .where(eq(attempts.attemptId, attemptId))
      .execute()
      .pipe(Effect.flatMap(decodeAttemptRows));
    if (own === undefined) return yield* Effect.die(new Error(`No attempt ${attemptId} recorded`));
    const ownWindow = windowOf(attemptFromRow(own));
    if (Option.isNone(ownWindow)) {
      yield* Effect.logDebug(
        "The Attempt ended before end times were recorded, so it has no window and none overlaps it",
        { attemptId },
      );
      return AttemptWindows.make({ own: ownWindow, overlapping: [] });
    }
    const item = database
      .select({ itemKey: triggerEvents.itemKey })
      .from(runs)
      .innerJoin(triggerEvents, eq(triggerEvents.eventId, runs.eventId))
      .where(eq(runs.runId, own.runId));
    const others = yield* database
      .select(attemptSelection)
      .from(attempts)
      .innerJoin(runs, eq(runs.runId, attempts.runId))
      .innerJoin(triggerEvents, eq(triggerEvents.eventId, runs.eventId))
      .where(
        and(
          inArray(triggerEvents.itemKey, item),
          eq(attempts.agent, own.agent),
          ne(attempts.attemptId, attemptId),
        ),
      )
      .orderBy(attempts.startedAt)
      .execute()
      .pipe(Effect.flatMap(decodeAttemptRows));
    return AttemptWindows.make({
      own: ownWindow,
      overlapping: others
        .flatMap((row) => Option.toArray(windowOf(attemptFromRow(row))))
        .filter((window) => windowsOverlap(ownWindow.value, window)),
    });
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
        workerKind: Option.getOrNull(attempt.workerKind),
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

  /** Records the parent model from the Attempt's `Started` envelope, clearing it for an Attempt without a parent session. */
  const updateAttemptParentModel = Effect.fn("RunStoreQueries.updateAttemptParentModel")(function* (
    attemptId: AttemptId,
    parentModel: Option.Option<ModelId>,
  ) {
    yield* database
      .update(attempts)
      .set({ parentModel: Option.getOrNull(parentModel) })
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

  return {
    attemptRows,
    attemptWindows,
    salvageCandidates,
    salvageCandidate,
    addAttempt,
    recordReattach,
    recordSalvage,
    recordComments,
    recordOutOfMemory,
    closeAttempt,
    settleCiAttempt,
    markIntervened,
    updateAttemptParentModel,
    recordAttemptResult,
  } as const;
};
