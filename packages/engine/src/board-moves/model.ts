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
    /** The managed repo whose item labels the move changes. */
    repository: RepositoryName,
    /** The current item of the task moved on the board. */
    itemKey: ItemKey,
    /**
     * The UTC time before the first label request, used to distinguish operator changes from
     * attempt writes.
     */
    at: Schema.DateTimeUtc,
    /** The source lane's name on the Board at the time. */
    fromLane: Schema.NonEmptyString,
    /** The target lane's name on the Board at the time. */
    toLane: Schema.NonEmptyString,
    /**
     * The nonempty list of target lane labels requested on GitHub, including labels already
     * present.
     */
    added: LabelNames.check(Schema.isNonEmpty()),
    /** The labels requested for removal, including labels already absent. */
    removed: LabelNames,
  },
) {}
