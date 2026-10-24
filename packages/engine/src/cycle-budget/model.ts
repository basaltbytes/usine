import { CycleBudgetAsk, CycleBudgetAskId, CycleGeneration } from "@usine/core/cycle-budget";
import { ItemKey } from "@usine/core/item";
import { RepositoryName } from "@usine/core/repository";
import { Schema } from "effect";

/** A reset whose Item still needs fresh trigger evaluation; acknowledgment is per generation. */
export class CycleBudgetReset extends Schema.Class<CycleBudgetReset>("CycleBudgetReset")({
  itemKey: ItemKey,
  repository: RepositoryName,
  generation: CycleGeneration,
}) {}

/** An error for an Ask that is absent, answered differently, or no longer current. */
export class CycleBudgetResetRejectedError extends Schema.TaggedError<CycleBudgetResetRejectedError>(
  "CycleBudgetResetRejectedError",
)("CycleBudgetResetRejectedError", { askId: CycleBudgetAskId }) {}

/** The reasons a cycle-budget Ask closes without a reset. `ItemClosed`: the Item was closed or merged. */
export const CYCLE_BUDGET_ASK_CLOSE_REASONS = ["ItemClosed"] as const;
export const CycleBudgetAskCloseReason = Schema.Literals(CYCLE_BUDGET_ASK_CLOSE_REASONS);
export type CycleBudgetAskCloseReason = typeof CycleBudgetAskCloseReason.Type;

export const BudgetRow = Schema.Struct({
  ...CycleBudgetReset.fields,
  ask: Schema.OptionFromNullOr(CycleBudgetAsk),
  resetPending: Schema.Boolean,
});
export type BudgetRow = typeof BudgetRow.Type;
