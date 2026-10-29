import { queryOptions } from "@tanstack/react-query";
import {
  RepositoryName,
  canonicalRepositoryName,
  splitRepositoryName,
} from "@usine/core/repository";
import type { NeedView, ProjectView } from "@usine/orchestrator/operator";
import { api } from "~/lib/api";
import { needCopy } from "~/lib/needs-you/strings";

/** Returns the path params for `/projects/$owner/$name`. */
export const projectParams = (repository: RepositoryName) => ({
  ...splitRepositoryName(repository),
  repository,
});

export const projectForRepository = (
  projects: ReadonlyArray<ProjectView>,
  repository: RepositoryName,
): ProjectView | undefined =>
  projects.find((project) =>
    [project.repository, ...project.repositories].some(
      (member) => canonicalRepositoryName(member) === canonicalRepositoryName(repository),
    ),
  );

/** Returns the count of Needs you entries per Project; entries without a Project are omitted. */
export const needsYouByProject = (
  needs: ReadonlyArray<NeedView>,
): ReadonlyMap<RepositoryName, number> => {
  const counts = new Map<RepositoryName, number>();
  for (const need of needs) {
    const repositories =
      need._tag === "UnresponsiveWorkerNeed"
        ? need.attempts.map(({ repository }) => repository)
        : [needCopy(need).repository];
    for (const repository of new Set(repositories))
      if (repository !== null) counts.set(repository, (counts.get(repository) ?? 0) + 1);
  }
  return counts;
};

const ACTIVE_OVERVIEW_REFRESH_MS = 2_000;
const IDLE_OVERVIEW_REFRESH_MS = 15_000;

/** Returns the overview query, which every route uses; the root loader prefetches it. */
export const overviewQuery = () =>
  queryOptions({
    queryKey: ["overview"] as const,
    queryFn: () => api((client) => client.overview()),
    meta: { refreshLabel: "Overview" },
    refetchInterval: (query) => {
      const overview = query.state.data;
      if (overview?._tag === "NeedsSetup") return false;
      const hasOpenRun = overview?.projects.some((project) =>
        project.runs.some(({ canCancel }) => canCancel),
      );
      return hasOpenRun === true ? ACTIVE_OVERVIEW_REFRESH_MS : IDLE_OVERVIEW_REFRESH_MS;
    },
  });
