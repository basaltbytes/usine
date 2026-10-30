import { CycleBudgetAsk, CycleBudgetAskId, CycleGeneration } from "@usine/core/cycle-budget";
import { ItemKey } from "@usine/core/item";
import { RepositoryName } from "@usine/core/repository";
import { Schema } from "effect";

/** A reset whose Item still needs fresh trigger evaluation; acknowledgment is per generation. */
export class CycleBudgetReset extends Schema.Class<CycleBudgetReset>("CycleBudgetReset")({
  /** The item whose budget reset requires a fresh trigger evaluation. */
  itemKey: ItemKey,
  /** The managed repo whose polling cursor must restart. */
  repository: RepositoryName,
  /** The generation created by this reset; acknowledging it must not clear a later reset. */
  generation: CycleGeneration,
}) {}

/** An error for an Ask that is absent, answered differently, or no longer current. */
export class CycleBudgetResetRejectedError extends Schema.TaggedError<CycleBudgetResetRejectedError>(
  "CycleBudgetResetRejectedError",
)("CycleBudgetResetRejectedError", {
  /** The ask that cannot accept this reset answer. */
  askId: CycleBudgetAskId,
}) {}

/** The reasons a cycle-budget Ask closes without a reset. `ItemClosed`: the Item was closed or merged. */
export const CYCLE_BUDGET_ASK_CLOSE_REASONS = ["ItemClosed"] as const;
/**
 * A reason to close an ask without resetting its budget. `ItemClosed` includes closed, merged, or
 * missing items (ADR 0022).
 */
export const CycleBudgetAskCloseReason = Schema.Literals(CYCLE_BUDGET_ASK_CLOSE_REASONS);
export type CycleBudgetAskCloseReason = typeof CycleBudgetAskCloseReason.Type;

export const BudgetRow = Schema.Struct({
  ...CycleBudgetReset.fields,
  ask: Schema.OptionFromNullOr(CycleBudgetAsk),
  resetPending: Schema.Boolean,
});
export type BudgetRow = typeof BudgetRow.Type;
