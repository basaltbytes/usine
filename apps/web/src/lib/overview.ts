import { ProjectId } from "@usine/core/project";
import { queryOptions } from "@tanstack/react-query";
import { RepositoryName, canonicalRepositoryName } from "@usine/core/repository";
import type { NeedView, ProjectView } from "@usine/orchestrator/operator";
import { api } from "~/lib/api";
import { needCopy } from "~/lib/needs-you/strings";

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
  projects: ReadonlyArray<ProjectView>,
): ReadonlyMap<ProjectId, number> => {
  const counts = new Map<ProjectId, number>();
  for (const need of needs) {
    const repositories =
      need._tag === "UnresponsiveWorkerNeed"
        ? need.attempts.map(({ repository }) => repository)
        : [needCopy(need).repository];
    const affected = new Set(
      repositories.flatMap((repository) => {
        const project =
          repository === null ? undefined : projectForRepository(projects, repository);
        return project === undefined ? [] : [projectId(project)];
      }),
    );
    for (const project of affected) counts.set(project, (counts.get(project) ?? 0) + 1);
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
    refetchInterval: (query) => {
      const overview = query.state.data;
      if (overview?._tag === "NeedsSetup") return false;
      const hasOpenRun = overview?.projects.some((project) =>
        project.runs.some(({ canCancel }) => canCancel),
      );
      return hasOpenRun === true ? ACTIVE_OVERVIEW_REFRESH_MS : IDLE_OVERVIEW_REFRESH_MS;
    },
  });

export const projectId = (project: ProjectView): ProjectId =>
  project.id ??
  ProjectId.make(
    project.repository
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, ""),
  );

export const projectName = (project: ProjectView): string => project.name ?? project.repository;

export const projectParams = (projects: ReadonlyArray<ProjectView>, repository: RepositoryName) => {
  const project = projectForRepository(projects, repository);
  return project === undefined ? undefined : { project: projectId(project) };
};
