import { EventId } from "./event.ts";
import { ItemKey } from "./item.ts";
import { LoopName } from "./loop.ts";
import { RepositoryName } from "./repository.ts";
import { Schema } from "effect";

/** The maximum number of Runs one Loop can open for an Item between operator resets. */
export const CycleLimit = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("CycleLimit"),
);
export type CycleLimit = typeof CycleLimit.Type;

/** The ID of the period between two operator resets of an Item's cycle budget. */
export const CycleGeneration = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand("CycleGeneration"),
);
export type CycleGeneration = typeof CycleGeneration.Type;

export const DEFAULT_CYCLE_LIMIT = CycleLimit.make(3);

/** The number of admitted or completed Runs of one Loop on an Item. */
export const CycleCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand("CycleCount"),
);
export type CycleCount = typeof CycleCount.Type;

/** The admitted and completed Runs of one Loop in the current cycle generation. */
export class LoopCycleCount extends Schema.Class<LoopCycleCount>("LoopCycleCount")(
  Schema.Struct({
    loop: LoopName,
    admitted: CycleCount,
    completed: CycleCount,
  })
    .check(
      Schema.makeFilter(({ admitted, completed }) => completed <= admitted, {
        message: "Completed Runs cannot exceed admitted Runs",
      }),
    )
    .annotate({ parseOptions: { onExcessProperty: "error" } }),
) {}

/** The ID of the Event and cycle generation that first exhausted an Item's budget. */
export const CycleBudgetAskId = EventId.pipe(Schema.brand("CycleBudgetAskId"));
export type CycleBudgetAskId = typeof CycleBudgetAskId.Type;

/** An Ask for the operator to reset an Item's cycle budget; no Runs open until the reset. */
export class CycleBudgetAsk extends Schema.Class<CycleBudgetAsk>("CycleBudgetAsk")(
  Schema.Struct({
    id: CycleBudgetAskId,
    itemKey: ItemKey,
    repository: RepositoryName,
    loop: LoopName,
    limit: CycleLimit,
    counts: Schema.NonEmptyArray(LoopCycleCount),
  })
    .check(
      Schema.makeFilter(
        ({ loop, limit, counts }) =>
          new Set(counts.map((count) => count.loop)).size === counts.length &&
          counts.some((count) => count.loop === loop && count.admitted >= limit),
        {
          message: "Expected unique participating Loops including the exhausted Loop at its limit",
        },
      ),
    )
    .annotate({ parseOptions: { onExcessProperty: "error" } }),
) {
  /** The highest `completed` count across Loops; each Loop runs at most once per round. */
  get completedCycles(): CycleCount {
    return CycleCount.make(Math.max(...this.counts.map(({ completed }) => completed)));
  }
}
