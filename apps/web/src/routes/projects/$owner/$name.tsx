import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { RepositoryName } from "@usine/core/repository";
import { BootScreen } from "@/components/boot-screen";
import { Button } from "@/components/ui/button";
import { ProjectBoard } from "../../../board/board.tsx";
import { overviewQuery } from "../../../overview.ts";
import { useOpenRun } from "../../../open-run.ts";

const ProjectNotFound = () => (
  <BootScreen
    title="Project not found"
    description="This repository is not registered with the running usine."
    tone="error"
  >
    <Button variant="outline" nativeButton={false} render={<Link to="/" />}>
      Back to projects
    </Button>
  </BootScreen>
);

const BoardRoute = () => {
  const { repository } = Route.useParams();
  const { data } = useSuspenseQuery(overviewQuery());
  const openRun = useOpenRun();
  const project = data.projects.find((candidate) => candidate.repository === repository);
  // A live refetch can drop the project after the loader admitted it.
  if (project === undefined) return <ProjectNotFound />;
  return <ProjectBoard project={project} disabled={data._tag === "NeedsSetup"} openRun={openRun} />;
};

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
  component: BoardRoute,
});
