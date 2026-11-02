import { queryOptions } from "@tanstack/react-query";
import type { ItemNumber } from "@usine/core/item";
import { type RepositoryName, splitRepositoryName } from "@usine/core/repository";

import { api } from "~/lib/api";

export const taskQuery = (repository: RepositoryName, number: ItemNumber) => {
  const { owner, name } = splitRepositoryName(repository);
  return queryOptions({
    queryKey: ["task", repository, number] as const,
    queryFn: () =>
      api((client) => client.task({ params: { owner, repository: name, item: number } }), "task"),
    staleTime: 30_000,
    meta: {
      refreshLabel: "Task",
      itemKeys: [JSON.stringify(["github", repository.toLowerCase(), number])],
    },
  });
};

/** Loads the complete run menu only when its history submenu opens. */
export const taskHistoryQuery = (repository: RepositoryName, number: ItemNumber) => {
  const { owner, name } = splitRepositoryName(repository);
  return queryOptions({
    staleTime: 30_000,
    meta: {
      refreshLabel: "Task",
      itemKeys: [JSON.stringify(["github", repository.toLowerCase(), number])],
    },
    queryKey: ["task", repository, number, "history"] as const,
    queryFn: () =>
      api((client) => client.task({ params: { owner, repository: name, item: number } })),
  });
};
