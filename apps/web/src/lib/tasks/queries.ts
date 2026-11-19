import { changes } from "~/lib/query-changes";
import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import type { ItemNumber } from "@usine/core/item";
import type { ProjectId } from "@usine/core/project";
import { type RepositoryName, splitRepositoryName } from "@usine/core/repository";

import { api } from "~/lib/api";

/** The project's full view: its board with every card's runs, its runs, and its label catalog. */
export const projectTasksQuery = (project: ProjectId) =>
  queryOptions({
    queryKey: ["project", project, "tasks"] as const,
    queryFn: () => api((client) => client.project({ params: { project } }), "full"),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    meta: {
      refreshLabel: "Tasks",
      projectId: project,
      changes: changes.any(changes.project(project), changes.kind("configuration")),
    },
  });

export const taskQuery = (repository: RepositoryName, number: ItemNumber) => {
  const { owner, name } = splitRepositoryName(repository);
  return queryOptions({
    queryKey: ["task", repository, number] as const,
    queryFn: () =>
      api((client) => client.task({ params: { owner, repository: name, item: number } }), "task"),
    staleTime: 30_000,
    meta: {
      refreshLabel: "Task",
      changes: changes.repository(repository),
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
      changes: changes.repository(repository),
    },
    queryKey: ["task", repository, number, "history"] as const,
    queryFn: () =>
      api((client) => client.task({ params: { owner, repository: name, item: number } }), "full"),
  });
};
