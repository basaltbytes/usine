import { ItemKey } from "@usine/core/item";
import { RepositoryName } from "@usine/core/repository";
import { Schema } from "effect";

const LabelNames = Schema.Array(Schema.NonEmptyString);

/**
 * One Board move the operator made: the lane labels the factory sent to GitHub for
 * the Item, as the App. `at` is taken just before the factory sends the first of
 * them, so GitHub records each change at or after it, give or take the two clocks'
 * skew. A label already on the Item, or already absent, is listed even though
 * GitHub records no change for it.
 */
export class BoardMoveRecord extends Schema.Class<BoardMoveRecord>("@usine/engine/BoardMoveRecord")(
  {
    repository: RepositoryName,
    itemKey: ItemKey,
    at: Schema.DateTimeUtc,
    /** The lane the card was in, by its name on the Board at the time. */
    fromLane: Schema.NonEmptyString,
    /** The lane the operator moved the card to, by its name on the Board at the time. */
    toLane: Schema.NonEmptyString,
    added: LabelNames.check(Schema.isNonEmpty()),
    removed: LabelNames,
  },
) {}
