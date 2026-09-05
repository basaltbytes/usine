import { CycleBudgetAsk, CycleBudgetAskId, LoopCycleCount } from "@usine/core/cycle-budget";
import { ItemKey } from "@usine/core/item";
import { EventId } from "@usine/core/event";
import { RunId } from "@usine/core/run";
import { and, asc, eq, exists, isNotNull, ne, or, sql } from "drizzle-orm";
import { Effect, Option, Schema } from "effect";
import type { RunDatabaseClient } from "../database/database.ts";
import {
  attempts,
  cycleReservations,
  itemCycleBudgets,
  runs,
  triggerEvents,
} from "../database/schema.ts";
import type { Submission } from "../engine/submission.ts";
import { BudgetRow } from "./model.ts";

const budgetSelection = {
  itemKey: itemCycleBudgets.itemKey,
  repository: itemCycleBudgets.repository,
  generation: itemCycleBudgets.generation,
  ask: itemCycleBudgets.askJson,
  resetPending: itemCycleBudgets.resetPending,
};
const decodeBudget = Schema.decodeUnknownEffect(Schema.Array(BudgetRow), {
  onExcessProperty: "error",
});

/** Transaction-local admission and reservation operations shared with the Run store. */
export const cycleQueries = (database: RunDatabaseClient) => {
  // Filter before queue ordering as well as at admission: a newer stale Event
  // must not hide an older Event that fresh polling has confirmed.
  const confirmedEvent = eq(
    triggerEvents.cycleGeneration,
    sql`coalesce((
    select ${itemCycleBudgets.generation} from ${itemCycleBudgets}
    where ${itemCycleBudgets.itemKey} = ${triggerEvents.itemKey}
  ), 0)`,
  );
  const get = Effect.fn("CycleBudget.get")(function* (itemKey: ItemKey) {
    yield* Effect.annotateCurrentSpan({ itemKey });
    const rows = yield* database
      .select(budgetSelection)
      .from(itemCycleBudgets)
      .where(eq(itemCycleBudgets.itemKey, itemKey))
      .execute()
      .pipe(Effect.flatMap(decodeBudget));
    return Option.fromNullishOr(rows[0]);
  });

  const counts = Effect.fn("CycleBudget.counts")(function* (budget: BudgetRow) {
    yield* Effect.annotateCurrentSpan({ itemKey: budget.itemKey, generation: budget.generation });
    const started = exists(
      database
        .select({ id: attempts.attemptId })
        .from(attempts)
        .where(eq(attempts.runId, runs.runId)),
    );
    const state = sql`json_extract(${runs.stateJson}, '$._tag')`;
    const rows = yield* database
      .select({
        loop: cycleReservations.loop,
        admitted: sql<number>`count(*)`,
        completed: sql<number>`sum(case when ${state} in ('Succeeded', 'Failed', 'Canceled') and ${started} then 1 else 0 end)`,
      })
      .from(cycleReservations)
      .innerJoin(runs, eq(runs.runId, cycleReservations.runId))
      .where(
        and(
          eq(cycleReservations.itemKey, budget.itemKey),
          eq(cycleReservations.generation, budget.generation),
          or(ne(state, "Canceled"), started),
        ),
      )
      .groupBy(cycleReservations.loop)
      .orderBy(asc(cycleReservations.loop))
      .execute();
    return yield* Schema.decodeUnknownEffect(Schema.Array(LoopCycleCount))(rows, {
      onExcessProperty: "error",
    });
  });

  const admit = Effect.fn("CycleBudget.admit")(function* (submission: Submission) {
    yield* Effect.annotateCurrentSpan({ itemKey: submission.itemKey, loop: submission.loop });
    const current = yield* get(submission.itemKey);
    if (Option.isSome(current) && Option.isSome(current.value.ask)) {
      yield* Effect.logInfo("Item cycle budget remains exhausted", {
        itemKey: submission.itemKey,
        askId: current.value.ask.value.id,
        loop: submission.loop,
      });
      return current.value.ask;
    }
    if (Option.isNone(submission.cycleLimit)) return Option.none<CycleBudgetAsk>();
    yield* database
      .insert(itemCycleBudgets)
      .values({ itemKey: submission.itemKey, repository: submission.repository })
      .onConflictDoNothing()
      .execute();
    const budget = yield* get(submission.itemKey);
    if (Option.isNone(budget))
      return yield* Effect.die(new Error("Cycle budget missing after insertion"));
    const participants = yield* counts(budget.value);
    const completed = participants.find(({ loop }) => loop === submission.loop);
    if (completed === undefined || completed.admitted < submission.cycleLimit.value)
      return Option.none<CycleBudgetAsk>();
    const ask = new CycleBudgetAsk({
      id: CycleBudgetAskId.make(
        EventId.make(JSON.stringify([submission.event.id, budget.value.generation])),
      ),
      itemKey: submission.itemKey,
      repository: submission.repository,
      loop: submission.loop,
      limit: submission.cycleLimit.value,
      counts: [completed, ...participants.filter(({ loop }) => loop !== submission.loop)],
    });
    yield* database
      .update(itemCycleBudgets)
      .set({ askJson: Schema.encodeSync(CycleBudgetAsk)(ask) })
      .where(eq(itemCycleBudgets.itemKey, submission.itemKey))
      .execute();
    yield* Effect.logWarning("Item cycle budget exhausted; operator reset required", {
      itemKey: submission.itemKey,
      repository: submission.repository,
      askId: ask.id,
      loop: ask.loop,
      limit: ask.limit,
      completedCycles: ask.completedCycles,
      counts: ask.counts,
    });
    return Option.some(ask);
  });

  const reserve = Effect.fn("CycleBudget.reserve")(function* (
    submission: Submission,
    runId: RunId,
  ) {
    if (Option.isNone(submission.cycleLimit)) return;
    yield* Effect.annotateCurrentSpan({
      runId,
      itemKey: submission.itemKey,
      loop: submission.loop,
    });
    const budget = yield* get(submission.itemKey);
    if (Option.isNone(budget))
      return yield* Effect.die(new Error("Run admitted without its cycle budget"));
    yield* database
      .insert(cycleReservations)
      .values({
        runId,
        itemKey: submission.itemKey,
        loop: submission.loop,
        generation: budget.value.generation,
      })
      .onConflictDoNothing()
      .execute();
    yield* Effect.logInfo("Item cycle reserved", {
      runId,
      itemKey: submission.itemKey,
      loop: submission.loop,
      generation: budget.value.generation,
      counts: yield* counts(budget.value),
    });
  });

  const asks = Effect.fn("CycleBudget.asks")(function* () {
    const rows = yield* database
      .select(budgetSelection)
      .from(itemCycleBudgets)
      .where(isNotNull(itemCycleBudgets.askJson))
      .execute()
      .pipe(Effect.flatMap(decodeBudget));
    return rows.flatMap(({ ask }) => Option.toArray(ask));
  });

  const pendingResets = Effect.fn("CycleBudget.pendingResets")(function* () {
    return yield* database
      .select(budgetSelection)
      .from(itemCycleBudgets)
      .where(eq(itemCycleBudgets.resetPending, true))
      .execute()
      .pipe(Effect.flatMap(decodeBudget));
  });

  const confirm = Effect.fn("CycleBudget.confirmObservedEvent")(function* (submission: Submission) {
    yield* Effect.annotateCurrentSpan({
      eventId: submission.event.id,
      itemKey: submission.itemKey,
    });
    const budget = yield* get(submission.itemKey);
    const generation = Option.match(budget, {
      onNone: () => 0,
      onSome: (value) => value.generation,
    });
    yield* database
      .update(triggerEvents)
      .set({ cycleGeneration: generation })
      .where(eq(triggerEvents.eventId, submission.event.id))
      .execute();
  });

  const canContinue = Effect.fn("CycleBudget.canContinue")(function* (submission: Submission) {
    yield* Effect.annotateCurrentSpan({
      eventId: submission.event.id,
      itemKey: submission.itemKey,
    });
    const budget = yield* get(submission.itemKey);
    if (Option.isNone(budget)) return true;
    const confirmed = yield* database
      .select({ eventId: triggerEvents.eventId })
      .from(triggerEvents)
      .where(and(eq(triggerEvents.eventId, submission.event.id), confirmedEvent))
      .execute()
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ eventId: EventId }))),
        ),
      );
    const current = confirmed.length > 0;
    if (!current)
      yield* Effect.logInfo("Queued Event awaits fresh trigger evaluation after cycle reset", {
        eventId: submission.event.id,
        itemKey: submission.itemKey,
        generation: budget.value.generation,
      });
    return current;
  });

  return { admit, reserve, get, asks, pendingResets, confirm, canContinue, confirmedEvent };
};
