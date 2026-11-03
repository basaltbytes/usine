import { Schema } from "effect";
import { RepositoryName } from "./repository.ts";

/** The ID of an issue or pull request; several Events can have the same Item. */
export const ItemKey = Schema.NonEmptyString.pipe(Schema.brand("ItemKey"));

export type ItemKey = typeof ItemKey.Type;

/** A positive GitHub issue or pull request number, unique within its repository. */
export const ItemNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("ItemNumber"),
);
export type ItemNumber = typeof ItemNumber.Type;

/**
 * The stable key of a GitHub issue or pull request: the canonical repository name and item number.
 * Schedule run keys contain only the repository and don't decode as an item.
 */
export const GitHubItemKey = Schema.toType(ItemKey).pipe(
  Schema.decodeTo(
    Schema.fromJsonString(Schema.Tuple([Schema.Literal("github"), RepositoryName, ItemNumber])),
  ),
);
