import { canonicalRepositoryName, RepositoryName } from "@usine/core/repository";
import { Option, Schema } from "effect";
import { uniqueRepositoryNames } from "./checks.ts";
import { RegistryTag, type ManagedRepo } from "./factory.ts";

/**
 * Repository names or tags that narrow a loop's project membership. When both are set, both must
 * match (ADR 0004).
 */
export class Selector extends Schema.Class<Selector>("@usine/config/Selector")({
  /** Repository names to match case-insensitively; `None` imposes no name restriction. */
  repos: Schema.OptionFromOptionalKey(
    Schema.Array(RepositoryName).check(
      Schema.isNonEmpty(),
      uniqueRepositoryNames((name: RepositoryName) => name),
    ),
  ),
  /** Tags of which a repository must have at least one; `None` imposes no tag restriction. */
  tags: Schema.OptionFromOptionalKey(
    Schema.Array(RegistryTag).check(Schema.isNonEmpty(), Schema.isUnique()),
  ),
}) {}

/** A selector with `repos` or `tags`; to include every repository, omit the selector. */
export const ValidSelector = Selector.check(
  Schema.makeFilter((selector) => Option.isSome(selector.repos) || Option.isSome(selector.tags), {
    message: "Expected selector.repos, selector.tags, or both",
  }),
);

/**
 * Returns whether `repo` passes `selector`, matching repository names case-insensitively. If both
 * `repos` and `tags` are set, both must match; `None` matches every repo.
 */
export const matchesSelector = (selector: Option.Option<Selector>, repo: ManagedRepo): boolean =>
  Option.match(selector, {
    onNone: () => true,
    onSome: (value) => {
      const matchesRepo = Option.match(value.repos, {
        onNone: () => true,
        onSome: (repos) =>
          repos.some(
            (name) => canonicalRepositoryName(name) === canonicalRepositoryName(repo.name),
          ),
      });
      const matchesTag = Option.match(value.tags, {
        onNone: () => true,
        onSome: (tags) => tags.some((tag) => repo.tags.includes(tag)),
      });
      return matchesRepo && matchesTag;
    },
  });
