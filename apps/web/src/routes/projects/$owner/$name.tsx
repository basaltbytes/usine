import { createFileRoute, notFound } from "@tanstack/react-router";
import { RepositoryName } from "@usine/core/repository";
import { ProjectNotFound } from "@/components/project-not-found";
import { overviewQuery } from "../../../overview.ts";

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
    if (!overview.projects.some(({ repository }) => repository === params.repository)) {
      throw notFound();
    }
  },
  notFoundComponent: ProjectNotFound,
});
