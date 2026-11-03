import type { ChangeTarget } from "@usine/core/changes";
import { GitHubItemKey, type ItemKey } from "@usine/core/item";
import type { ProjectId } from "@usine/core/project";
import { canonicalRepositoryName, type RepositoryName } from "@usine/core/repository";
import type { RunId } from "@usine/core/run";
import { Option, Schema } from "effect";

type ChangePredicate = (target: ChangeTarget) => boolean;

type QueryMeta = { readonly projectId?: ProjectId } & (
  | {
      readonly refreshLabel: string;
      readonly changes: ChangePredicate;
      readonly utcDayRollover?: boolean;
    }
  | {
      readonly refreshLabel?: never;
      readonly changes?: never;
      readonly utcDayRollover?: never;
    }
);

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: QueryMeta;
  }
}

const decodeItemKey = Schema.decodeUnknownOption(GitHubItemKey);
const kind =
  (...kinds: ReadonlyArray<ChangeTarget["kind"]>): ChangePredicate =>
  (target) =>
    kinds.includes(target.kind);

export const changes = {
  kind,
  project:
    (project: ProjectId): ChangePredicate =>
    (target) =>
      target.kind === "project" && target.id === project,
  run:
    (run: RunId): ChangePredicate =>
    (target) =>
      target.kind === "run" && target.id === run,
  item:
    (items: ReadonlyArray<ItemKey>): ChangePredicate =>
    (target) =>
      target.kind === "item" && items.some((item) => item === target.id),
  repository:
    (repository: RepositoryName): ChangePredicate =>
    (target) => {
      if (target.kind !== "item") return false;
      const item = decodeItemKey(target.id);
      return (
        Option.isSome(item) &&
        canonicalRepositoryName(item.value[1]) === canonicalRepositoryName(repository)
      );
    },
  any:
    (...predicates: ReadonlyArray<ChangePredicate>): ChangePredicate =>
    (target) =>
      predicates.some((predicate) => predicate(target)),
};
