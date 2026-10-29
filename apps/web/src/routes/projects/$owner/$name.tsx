import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";
import { RepositoryName } from "@usine/core/repository";
import { ProjectNotFound } from "~/components/project-not-found";
import { overviewQuery, projectForRepository } from "~/lib/overview";

const ProjectLayout = () => <Outlet />;

export const Route = createFileRoute("/projects/$owner/$name")({
  params: {
    parse: ({ owner, name }) => ({
      owner,
      name,
      repository: RepositoryName.make(`${owner}/${name}`),
    }),
    stringify: ({ owner, name }) => ({ owner, name }),
  },
  loader: async ({ context, params }) => {
    const overview = await context.queryClient.ensureQueryData(overviewQuery());
    if (projectForRepository(overview.projects, params.repository) === undefined) {
      throw notFound();
    }
  },
  component: ProjectLayout,
  notFoundComponent: ProjectNotFound,
});
