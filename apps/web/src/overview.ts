import type { Query } from "@tanstack/react-query";
import { RepositoryName, splitRepositoryName } from "@usine/core/repository";
import type { FactoryOverview, NeedView } from "@usine/orchestrator/operator";
import { api } from "./api.ts";
import { needCopy } from "./operator-copy.ts";

/** Path params for /projects/$owner/$name in the shape the route declares. */
export const projectParams = (repository: RepositoryName) => ({
  ...splitRepositoryName(repository),
  repository,
});

/** How many Needs you entries concern each Project; entries about no Project are left out. */
export const needsYouByProject = (
  needs: ReadonlyArray<NeedView>,
): ReadonlyMap<RepositoryName, number> => {
  const counts = new Map<RepositoryName, number>();
  for (const need of needs) {
    const repository = needCopy(need).repository;
    if (repository !== null) counts.set(repository, (counts.get(repository) ?? 0) + 1);
  }
  return counts;
};

const ACTIVE_OVERVIEW_REFRESH_MS = 2_000;
const IDLE_OVERVIEW_REFRESH_MS = 15_000;

/** The one overview query every route reads; the root loader primes it. */
export const overviewQuery = () => ({
  queryKey: ["overview"] as const,
  queryFn: () => api((client) => client.overview()),
  refetchInterval: (
    query: Query<FactoryOverview, Error, FactoryOverview, readonly ["overview"]>,
  ) => {
    const overview = query.state.data;
    if (overview?._tag === "NeedsSetup") return false;
    const hasOpenRun = overview?.projects.some((project) =>
      project.runs.some(({ canCancel }) => canCancel),
    );
    return hasOpenRun === true ? ACTIVE_OVERVIEW_REFRESH_MS : IDLE_OVERVIEW_REFRESH_MS;
  },
});
