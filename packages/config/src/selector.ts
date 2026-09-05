import { RepositoryName } from "@usine/core/repository";
import { Option, Schema } from "effect";
import { RegistryTag, type ManagedRepo } from "./factory.ts";

/** Narrows a Loop to registry repositories by name, by any listed tag, or by both criteria together. */
export class Selector extends Schema.Class<Selector>("@usine/config/Selector")({
  repos: Schema.OptionFromOptionalKey(
    Schema.Array(RepositoryName).check(Schema.isNonEmpty(), Schema.isUnique()),
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

/** Whether a repo passes the selector. Both axes must match when present; no selector matches every repo. */
export const matchesSelector = (selector: Option.Option<Selector>, repo: ManagedRepo): boolean =>
  Option.match(selector, {
    onNone: () => true,
    onSome: (value) => {
      const matchesRepo = Option.match(value.repos, {
        onNone: () => true,
        onSome: (repos) => repos.includes(repo.name),
      });
      const matchesTag = Option.match(value.tags, {
        onNone: () => true,
        onSome: (tags) => tags.some((tag) => repo.tags.includes(tag)),
      });
      return matchesRepo && matchesTag;
    },
  });
