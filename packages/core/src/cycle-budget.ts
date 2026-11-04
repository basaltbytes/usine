import { closedStruct } from "./closed-struct.ts";
import { EventId } from "./event.ts";
import { ItemKey } from "./item.ts";
import { LoopName } from "./loop.ts";
import { RepositoryName } from "./repository.ts";
import { type Brand, Effect, Schema } from "effect";

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

/** The default limit of three runs per loop and item between operator resets (ADR 0022). */
export const DEFAULT_CYCLE_LIMIT = CycleLimit.make(3);

/** The number of admitted or completed Runs of one Loop on an Item. */
export const CycleCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand("CycleCount"),
);
export type CycleCount = typeof CycleCount.Type;

/** The admitted and completed Runs of one Loop in the current cycle generation. */
export class LoopCycleCount extends Schema.Class<
  LoopCycleCount,
  Brand.Brand<"@usine/core/cycle-budget/LoopCycleCount">
>("LoopCycleCount")(
  closedStruct({
    /** The loop whose runs are counted in this cycle generation. */
    loop: LoopName,
    /** The runs opened for this loop and item since the last reset. */
    admitted: CycleCount,
    /** The admitted runs that have completed; never greater than `admitted`. */
    completed: CycleCount,
  }).check(
    Schema.makeFilter(({ admitted, completed }) => completed <= admitted, {
      message: "Completed runs can't exceed admitted runs",
    }),
  ),
) {}

/** The ID of the Event and cycle generation that first exhausted an Item's budget. */
export const CycleBudgetAskId = EventId.pipe(Schema.brand("CycleBudgetAskId"));
export type CycleBudgetAskId = typeof CycleBudgetAskId.Type;

/** The latest event refused by an item's exhausted budget for one loop. */
export class CycleBudgetBlock extends Schema.Class<
  CycleBudgetBlock,
  Brand.Brand<"@usine/core/cycle-budget/CycleBudgetBlock">
>("CycleBudgetBlock")(
  closedStruct({
    loop: LoopName,
    eventId: EventId,
  }),
) {}

/** An Ask for the operator to reset an Item's cycle budget; no Runs open until the reset. */
export class CycleBudgetAsk extends Schema.Class<
  CycleBudgetAsk,
  Brand.Brand<"@usine/core/cycle-budget/CycleBudgetAsk">
>("CycleBudgetAsk")(
  closedStruct({
    /** The event-derived identity of the ask in this cycle generation. */
    id: CycleBudgetAskId,
    /** The item whose budget prevents further runs. */
    itemKey: ItemKey,
    /** The managed repo containing the item. */
    repository: RepositoryName,
    /** The loop whose admitted runs reached its limit. */
    loop: LoopName,
    /** The maximum runs allowed for the exhausted loop before an operator reset. */
    limit: CycleLimit,
    /** The distinct participating loops and their counts, including the exhausted loop. */
    counts: Schema.NonEmptyArray(LoopCycleCount),
    /** The latest refused event per loop, ordered by when each block changed. */
    blocks: Schema.Array(CycleBudgetBlock)
      .check(
        Schema.makeFilter(
          (blocks) => new Set(blocks.map(({ loop }) => loop)).size === blocks.length,
          {
            message: "Expected one blocked event per loop",
          },
        ),
      )
      .pipe(
        Schema.withDecodingDefaultKey(Effect.succeed([])),
        Schema.withConstructorDefault(Effect.succeed([])),
      ),
  }).check(
    Schema.makeFilter(
      ({ loop, limit, counts }) =>
        new Set(counts.map((count) => count.loop)).size === counts.length &&
        counts.some((count) => count.loop === loop && count.admitted >= limit),
      {
        message: "Expected unique participating loops, including the exhausted loop at its limit",
      },
    ),
  ),
) {
  /** The loop most recently blocked, or the exhausted loop for older asks. */
  get blockedLoop(): LoopName {
    return this.blocks.at(-1)?.loop ?? this.loop;
  }

  /** Records a changed block; repeated sightings of the same event preserve the ask. */
  recordBlock(loop: LoopName, eventId: EventId): CycleBudgetAsk {
    if (this.blocks.some((block) => block.loop === loop && block.eventId === eventId)) return this;
    return CycleBudgetAsk.make({
      ...this,
      blocks: [
        ...this.blocks.filter((block) => block.loop !== loop),
        CycleBudgetBlock.make({ loop, eventId }),
      ],
    });
  }

  /** The highest `completed` count across Loops; each Loop runs at most once per round. */
  get completedCycles(): CycleCount {
    return CycleCount.make(Math.max(...this.counts.map(({ completed }) => completed)));
  }
}
