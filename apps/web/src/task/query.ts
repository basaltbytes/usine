import type { Query } from "@tanstack/react-query";
import type { ItemNumber } from "@usine/core/item";
import { type RepositoryName, splitRepositoryName } from "@usine/core/repository";
import type { TaskView } from "@usine/orchestrator/operator";
import { api } from "../api.ts";

const ACTIVE_TASK_REFRESH_MS = 2_000;
const IDLE_TASK_REFRESH_MS = 15_000;

/**
 * One Task's view. The key sits under the overview's, so every action that refreshes the
 * overview, a Run action or a Board move, refreshes the Task too.
 */
export const taskQuery = (repository: RepositoryName, number: ItemNumber) => {
  const { owner, name } = splitRepositoryName(repository);
  return {
    queryKey: ["overview", "task", repository, number] as const,
    queryFn: () =>
      api((client) => client.task({ params: { owner, repository: name, item: number } })),
    refetchInterval: (query: Query<TaskView, Error, TaskView, readonly unknown[]>) =>
      query.state.data?.runs.some(({ canCancel }) => canCancel) === true
        ? ACTIVE_TASK_REFRESH_MS
        : IDLE_TASK_REFRESH_MS,
  };
};
