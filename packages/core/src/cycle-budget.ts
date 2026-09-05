import { EventId } from "./event.ts";
import { ItemKey } from "./item.ts";
import { LoopName } from "./loop.ts";
import { RepositoryName } from "./repository.ts";
import { Schema } from "effect";

/** Maximum Runs one Loop may open for an Item between operator resets. */
export const CycleLimit = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("CycleLimit"),
);
export type CycleLimit = typeof CycleLimit.Type;

/** The safe default for unattended rounds on an Item. */
export const DEFAULT_CYCLE_LIMIT = CycleLimit.make(3);

/** Number of admitted or completed rounds for one Loop on an Item. */
export const CycleCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand("CycleCount"),
);
export type CycleCount = typeof CycleCount.Type;

/** A Loop's charged Runs and settled Runs in the current cycle budget. */
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

/** Identifies the Event and budget generation that first exhausted an Item's allowance. */
export const CycleBudgetAskId = EventId.pipe(Schema.brand("CycleBudgetAskId"));
export type CycleBudgetAskId = typeof CycleBudgetAskId.Type;

/** An Item-level request for an operator reset before further Runs can open. */
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
  /** The furthest completed round; each Loop participates at most once per round. */
  get completedCycles(): CycleCount {
    return CycleCount.make(Math.max(...this.counts.map(({ completed }) => completed)));
  }
}
