import { ItemKey } from "@usine/core/item";
import { RepositoryName } from "@usine/core/repository";
import { Schema } from "effect";

const LabelNames = Schema.Array(Schema.NonEmptyString);

/**
 * An operator Board move and the lane labels sent to GitHub for it, including labels that were
 * already in the requested state. `at` is taken before the first label is sent, so GitHub's
 * change times are at or after it, within clock skew.
 */
export class BoardMoveRecord extends Schema.Class<BoardMoveRecord>("@usine/engine/BoardMoveRecord")(
  {
    repository: RepositoryName,
    itemKey: ItemKey,
    at: Schema.DateTimeUtc,
    /** The source lane's name on the Board at the time. */
    fromLane: Schema.NonEmptyString,
    /** The target lane's name on the Board at the time. */
    toLane: Schema.NonEmptyString,
    added: LabelNames.check(Schema.isNonEmpty()),
    removed: LabelNames,
  },
) {}
