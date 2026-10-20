import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { RepositoryName } from "@usine/core/repository";
import { BootScreen } from "@/components/boot-screen";
import { Button } from "@/components/ui/button";
import { overviewQuery } from "../../../overview.ts";

const ProjectNotFound = () => (
  <BootScreen
    title="Project not found"
    description="This repository is not registered with the running usine."
    tone="error"
    inPanel
  >
    <Button variant="outline" nativeButton={false} render={<Link to="/" />}>
      Back to the desk
    </Button>
  </BootScreen>
);

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
