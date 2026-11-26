import { CiPolicy } from "@usine/core/ci";
import { EventId, type DedupKey } from "@usine/core/event";
import type { RunAgain } from "@usine/core/run/again";
import type { RunId } from "@usine/core/run";
import { desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { Effect, Option, Schema } from "effect";
import type { RunDatabaseClient } from "../../database/database.ts";
import {
  events,
  ignoredEvents,
  runAgainEvents,
  runs,
  triggerEvents,
} from "../../database/schema.ts";
import { Submission } from "../../engine/submission.ts";
import {
  decodeDiscards,
  decodeEventRoutes,
  decodeReopenedEvents,
  decodeReopenings,
  decodeRunIds,
  encodeAgent,
  encodeDateTime,
  encodePayload,
  submissionFromRow,
} from "../codec.ts";

export const eventRouteSelection = {
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
  ciInstructions: triggerEvents.ciInstructions,
  ciFailureHead: triggerEvents.ciFailureHead,
  ciOnGreen: triggerEvents.ciOnGreenJson,
  outcomeLabels: triggerEvents.outcomeLabelsJson,
  cycleLimit: triggerEvents.cycleLimit,
  cycleGeneration: triggerEvents.cycleGeneration,
  repository: triggerEvents.repository,
  revision: triggerEvents.revision,
  task: triggerEvents.task,
  agent: triggerEvents.agentJson,
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
    ciInstructions: Option.getOrNull(submission.ciInstructions),
    outcomeLabelsJson: [...submission.outcomeLabels],
    cycleLimit: Option.getOrNull(submission.cycleLimit),
    agentJson: yield* encodeAgent(submission.agent),
  };
});

/** Returns the trigger Event ledger queries that run on the caller's transaction. */
export const eventQueries = (database: RunDatabaseClient) => {
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
   * Replaces the Loop settings saved with a queued Event by `submission`'s: approval, permissions,
   * CI policy and its generated instructions, outcome labels, cycle limit, Agent, parent model, and
   * task.
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

  return {
    eventRouteByRun,
    recordTriggerEvent,
    recordSettings,
    newestReopening,
    reopenedEvent,
    recordRunAgain,
    runForEvent,
    ignoredEvent,
  } as const;
};
