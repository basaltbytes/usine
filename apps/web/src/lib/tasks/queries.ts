import { queryOptions } from "@tanstack/react-query";
import type { ItemNumber } from "@usine/core/item";
import { type RepositoryName, splitRepositoryName } from "@usine/core/repository";
import { overviewQuery } from "~/lib/overview";
import { api } from "~/lib/api";

const ACTIVE_TASK_REFRESH_MS = 2_000;
const IDLE_TASK_REFRESH_MS = 15_000;

/** The key starts with `"overview"`, so invalidating the overview query also refetches the Task. */
export const taskQuery = (repository: RepositoryName, number: ItemNumber) => {
  const { owner, name } = splitRepositoryName(repository);
  return queryOptions({
    queryKey: [...overviewQuery().queryKey, "task", repository, number] as const,
    queryFn: () =>
      api((client) => client.task({ params: { owner, repository: name, item: number } })),
    meta: { refreshLabel: "Task" },
    refetchInterval: (query) =>
      query.state.data?.runs.some(({ canCancel }) => canCancel) === true
        ? ACTIVE_TASK_REFRESH_MS
        : IDLE_TASK_REFRESH_MS,
  });
};
