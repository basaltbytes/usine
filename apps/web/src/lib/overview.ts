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

/** Navigation and attention data; boards and histories have separate queries. */
export const overviewQuery = () =>
  queryOptions({
    queryKey: ["overview"] as const,
    queryFn: () => api((client) => client.overview(), "shell"),
    staleTime: 60_000,
    meta: { refreshLabel: "Overview" },
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

/** Loads searchable board cards only when command search opens. */
export const searchQuery = () =>
  queryOptions({
    queryKey: ["search"] as const,
    queryFn: () => api((client) => client.overview()),
    staleTime: 60_000,
    meta: { refreshLabel: "Search" },
  });

/** Attention reads are separate from navigation so board changes do not refresh the tray. */
export const attentionQuery = () =>
  queryOptions({
    queryKey: ["overview", "attention"] as const,
    queryFn: () => api((client) => client.overview(), "attention"),
    staleTime: 30_000,
    meta: { refreshLabel: "Needs attention" },
  });
