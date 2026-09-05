import { CycleBudgetAsk, CycleBudgetAskId } from "@usine/core/cycle-budget";
import { ItemKey } from "@usine/core/item";
import { RepositoryName } from "@usine/core/repository";
import { Schema } from "effect";

const CycleGeneration = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand("CycleGeneration"),
);

/** A reset whose Item still needs fresh trigger evaluation; acknowledgement is generation-bound. */
export class CycleBudgetReset extends Schema.Class<CycleBudgetReset>("CycleBudgetReset")({
  itemKey: ItemKey,
  repository: RepositoryName,
  generation: CycleGeneration,
}) {}

/** The requested Ask is absent, already answered differently, or no longer current. */
export class CycleBudgetResetRejectedError extends Schema.TaggedError<CycleBudgetResetRejectedError>(
  "CycleBudgetResetRejectedError",
)("CycleBudgetResetRejectedError", { askId: CycleBudgetAskId }) {}

export const BudgetRow = Schema.Struct({
  ...CycleBudgetReset.fields,
  ask: Schema.OptionFromNullOr(CycleBudgetAsk),
  resetPending: Schema.Boolean,
});
export type BudgetRow = typeof BudgetRow.Type;
