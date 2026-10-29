import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";
import { RepositoryName } from "@usine/core/repository";
import { ProjectNotFound } from "~/components/project-not-found";
import { overviewQuery, projectForRepository, projectId } from "~/lib/overview";

export const Route = createFileRoute("/projects/$project/$name")({
  beforeLoad: async ({ context, params }) => {
    const repository = RepositoryName.make(`${params.project}/${params.name}`);
    const overview = await context.queryClient.ensureQueryData(overviewQuery());
    const project = projectForRepository(overview.projects, repository);
    if (project === undefined) throw notFound();
    return { legacyProject: projectId(project), legacyRepository: repository };
  },
  component: Outlet,
  notFoundComponent: ProjectNotFound,
});
