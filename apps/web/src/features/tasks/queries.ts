import { changes } from "~/lib/query-changes";
import { infiniteQueryOptions, keepPreviousData, queryOptions } from "@tanstack/react-query";
import type { ProjectId } from "@usine/core/project";
import { splitRepositoryName } from "@usine/core/repository";
import type { TaskView } from "@usine/orchestrator/operator";
import { api } from "~/lib/api";

export const projectTasksQuery = (project: ProjectId) =>
  queryOptions({
    queryKey: ["project", project, "tasks"] as const,
    queryFn: () => api((client) => client.project({ params: { project } })),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    meta: {
      refreshLabel: "Tasks",
      projectId: project,
      changes: changes.any(changes.project(project), changes.kind("configuration")),
    },
  });

export const taskRunsQuery = (task: TaskView) => {
  const { owner, name: repository } = splitRepositoryName(task.repository);
  return infiniteQueryOptions({
    queryKey: ["task", task.repository, task.number, "runs"] as const,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api((client) =>
        client.taskRuns({
          params: { owner, repository, item: task.number },
          query: { offset: pageParam },
        }),
      ),
    getNextPageParam: (page) => page.nextOffset ?? undefined,
    initialData: {
      pages: [
        {
          runs: task.runs,
          total: task.runsTotal ?? task.runs.length,
          nextOffset:
            task.runsTotal !== undefined && task.runsTotal > task.runs.length
              ? task.runs.length
              : null,
        },
      ],
      pageParams: [0],
    },
    staleTime: 30_000,
    meta: {
      refreshLabel: "Runs",
      changes: changes.any(
        changes.repository(task.repository),
        changes.item(task.items.map(({ itemKey }) => itemKey)),
      ),
    },
  });
};
