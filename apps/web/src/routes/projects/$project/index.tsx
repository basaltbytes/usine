import { ProjectId } from "@usine/core/project";
import { projectQuery } from "~/features/projects/queries";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { RouteError, RoutePending } from "~/components/route-status";
import { ProjectNotFound } from "~/components/project-not-found";
import { ProjectBoard } from "~/features/projects/board.page";
import { deskQuery } from "~/lib/desk/queries";
import { overviewQuery } from "~/lib/overview";
import { useOpenRun } from "~/hooks/use-open-run";

const BoardRoute = () => {
  const { project: slug } = Route.useParams();
  const { data } = useSuspenseQuery({
    ...overviewQuery(),
    select: (view) => ({ loops: view.loops, readOnly: view._tag === "NeedsSetup" }),
  });
  const desk = useSuspenseQuery(deskQuery());
  const openRun = useOpenRun();
  const { data: project } = useSuspenseQuery(projectQuery(ProjectId.make(slug)));
  // A refetch after the loader ran can remove the project.
  if (project === undefined) return <ProjectNotFound />;
  return (
    <ProjectBoard
      project={project}
      loops={data.loops}
      stalled={desk.data.notMoving}
      disabled={data.readOnly}
      openRun={openRun}
    />
  );
};

export const Route = createFileRoute("/projects/$project/")({
  loader: ({ context, params }) =>
    Promise.all([
      context.queryClient.ensureQueryData(deskQuery()),
      context.queryClient.ensureQueryData(projectQuery(ProjectId.make(params.project))),
    ]),
  pendingComponent: RoutePending,
  errorComponent: RouteError,
  component: BoardRoute,
});
