import { canonicalRepositoryName, RepositoryName } from "@usine/core/repository";
import { Option, Schema } from "effect";
import { uniqueRepositoryNames } from "./checks.ts";
import { RegistryTag, type ManagedRepo } from "./factory.ts";

/** Narrows a Loop to registry repositories by name, by any listed tag, or by both criteria together. */
export class Selector extends Schema.Class<Selector>("@usine/config/Selector")({
  repos: Schema.OptionFromOptionalKey(
    Schema.Array(RepositoryName).check(
      Schema.isNonEmpty(),
      uniqueRepositoryNames((name: RepositoryName) => name),
    ),
  ),
  tags: Schema.OptionFromOptionalKey(
    Schema.Array(RegistryTag).check(Schema.isNonEmpty(), Schema.isUnique()),
  ),
}) {}

/** An authored selector must name repositories or tags; omit the selector entirely to include every repository. */
export const ValidSelector = Selector.check(
  Schema.makeFilter((selector) => Option.isSome(selector.repos) || Option.isSome(selector.tags), {
    message: "Expected selector.repos, selector.tags, or both",
  }),
);

/**
 * Whether a repo passes the selector. Both axes must match when present; no
 * selector matches every repo. Repository names match ignoring case, as on GitHub.
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
