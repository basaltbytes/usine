import { Option } from "effect";
import type { ManagedRepo, Selector } from "./model.ts";

/** Match both selector axes when both are present; an omitted selector matches every repo. */
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
