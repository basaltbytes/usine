import { CycleBudgetAsk, CycleBudgetAskId, CycleGeneration } from "@usine/core/cycle-budget";
import { ItemKey } from "@usine/core/item";
import { Event } from "@usine/core/event";
import * as RunState from "@usine/core/run/state";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Context, Effect, Layer, Option } from "effect";
import { RunDatabase } from "../database/database.ts";
import {
  cycleReservations,
  cycleResets,
  events,
  itemCycleBudgets,
  runs,
} from "../database/schema.ts";
import { EnginePersistenceError } from "../engine/error.ts";
import { encodeDateTime, encodePayload } from "../store/codec.ts";
import { CycleBudgetReset, CycleBudgetResetRejectedError } from "./model.ts";
import { cycleQueries } from "./queries.ts";

const persistence = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) =>
      cause instanceof CycleBudgetResetRejectedError
        ? cause
        : new EnginePersistenceError({ operation: "update cycle budget", cause }),
    ),
  );

/** The service for Item-level cycle-budget Asks and operator resets. */
export class CycleBudgets extends Context.Service<
  CycleBudgets,
  {
    /** Returns the Item's cycle generation; callers read it before fetching trigger input and include it in the Event identity. */
    readonly generation: (
      itemKey: ItemKey,
    ) => Effect.Effect<CycleGeneration, EnginePersistenceError>;
    /** Returns all unanswered cycle-budget Asks, including those for Items whose labels no longer match. */
    readonly asks: () => Effect.Effect<ReadonlyArray<CycleBudgetAsk>, EnginePersistenceError>;
    /** Records the answer to the Ask and requests fresh trigger evaluation; repeated calls are idempotent. */
    readonly reset: (
      askId: CycleBudgetAskId,
      answer: Event,
    ) => Effect.Effect<void, EnginePersistenceError | CycleBudgetResetRejectedError>;
    /** Returns the resets that still wait for a durable polling-cursor restart. */
    readonly pendingResets: () => Effect.Effect<
      ReadonlyArray<CycleBudgetReset>,
      EnginePersistenceError
    >;
    /** Acknowledges the reset for its generation only, after fresh polling progress is recorded. */
    readonly acknowledgeReset: (
      reset: CycleBudgetReset,
    ) => Effect.Effect<void, EnginePersistenceError>;
  }
>()("@usine/engine/CycleBudgets") {
  static readonly layer = Layer.effect(
    CycleBudgets,
    Effect.gen(function* () {
      const database = yield* RunDatabase;
      const queries = cycleQueries(database);
      const generation = Effect.fn("CycleBudgets.generation")(function* (itemKey: ItemKey) {
        yield* Effect.annotateCurrentSpan({ itemKey });
        const budget = yield* queries
          .get(itemKey)
          .pipe(
            Effect.mapError(
              (cause) => new EnginePersistenceError({ operation: "read cycle generation", cause }),
            ),
          );
        return Option.match(budget, {
          onNone: () => CycleGeneration.make(0),
          onSome: (row) => row.generation,
        });
      });
      const asks = Effect.fn("CycleBudgets.asks")(() =>
        queries
          .asks()
          .pipe(
            Effect.mapError(
              (cause) => new EnginePersistenceError({ operation: "read cycle Asks", cause }),
            ),
          ),
      );
      const reset = Effect.fn("CycleBudgets.reset")(function* (
        askId: CycleBudgetAskId,
        answer: Event,
      ) {
        yield* Effect.annotateCurrentSpan({ askId, eventId: answer.id });
        yield* database
          .transaction((transaction) =>
            Effect.gen(function* () {
              const previous = yield* transaction
                .select()
                .from(cycleResets)
                .where(eq(cycleResets.askId, askId))
                .execute();
              if (previous[0]?.eventId === answer.id) {
                yield* Effect.logInfo("Cycle budget reset answer already recorded", {
                  askId,
                  eventId: answer.id,
                });
                return;
              }
              const ask = (yield* cycleQueries(transaction).asks()).find(({ id }) => id === askId);
              if (ask === undefined) return yield* new CycleBudgetResetRejectedError({ askId });
              const budget = yield* cycleQueries(transaction).get(ask.itemKey);
              if (Option.isNone(budget))
                return yield* Effect.die(new Error("Open cycle Ask has no budget"));
              const generation = budget.value.generation + 1;
              yield* transaction
                .insert(events)
                .values({
                  eventId: answer.id,
                  dedupKey: answer.dedupKey,
                  payloadJson: encodePayload(answer.payload),
                  receivedAt: encodeDateTime(answer.receivedAt),
                })
                .execute();
              yield* transaction
                .insert(cycleResets)
                .values({ askId, eventId: answer.id, itemKey: ask.itemKey })
                .execute();
              yield* transaction
                .update(itemCycleBudgets)
                .set({ generation, askJson: null, resetPending: true })
                .where(eq(itemCycleBudgets.itemKey, ask.itemKey))
                .execute();
              // Unstarted Runs move their reservation to the new generation. Started Runs keep the
              // old one, and retries don't charge again.
              yield* transaction
                .update(cycleReservations)
                .set({ generation })
                .where(
                  and(
                    eq(cycleReservations.itemKey, ask.itemKey),
                    inArray(
                      cycleReservations.runId,
                      transaction
                        .select({ runId: runs.runId })
                        .from(runs)
                        .where(
                          inArray(sql`json_extract(${runs.stateJson}, '$._tag')`, [
                            ...RunState.UNSTARTED_STATE_TAGS,
                          ]),
                        ),
                    ),
                  ),
                )
                .execute();
              yield* Effect.logInfo("Operator reset Item cycle budget", {
                askId,
                eventId: answer.id,
                itemKey: ask.itemKey,
                repository: ask.repository,
                generation,
                completedCycles: ask.completedCycles,
                counts: ask.counts,
              });
            }),
          )
          .pipe(persistence);
      });
      const pendingResets = Effect.fn("CycleBudgets.pendingResets")(() =>
        queries.pendingResets().pipe(
          Effect.map((rows) => rows.map((row) => new CycleBudgetReset(row))),
          Effect.mapError(
            (cause) =>
              new EnginePersistenceError({ operation: "read pending cycle resets", cause }),
          ),
        ),
      );
      const acknowledgeReset = Effect.fn("CycleBudgets.acknowledgeReset")(function* (
        reset: CycleBudgetReset,
      ) {
        yield* Effect.annotateCurrentSpan({ itemKey: reset.itemKey, generation: reset.generation });
        yield* database
          .update(itemCycleBudgets)
          .set({ resetPending: false })
          .where(
            and(
              eq(itemCycleBudgets.itemKey, reset.itemKey),
              eq(itemCycleBudgets.generation, reset.generation),
            ),
          )
          .execute()
          .pipe(
            Effect.mapError(
              (cause) =>
                new EnginePersistenceError({ operation: "acknowledge cycle reset", cause }),
            ),
          );
        yield* Effect.logInfo("Cycle reset trigger refresh recorded", {
          itemKey: reset.itemKey,
          generation: reset.generation,
        });
      });
      return { generation, asks, reset, pendingResets, acknowledgeReset };
    }),
  );
}

export { CycleBudgetReset, CycleBudgetResetRejectedError } from "./model.ts";
