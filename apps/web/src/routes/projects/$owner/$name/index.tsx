import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { RouteError, RoutePending } from "~/components/route-status";
import { ProjectNotFound } from "~/components/project-not-found";
import { ProjectBoard } from "~/features/projects/board.page";
import { deskQuery } from "~/lib/desk/queries";
import { overviewQuery } from "~/lib/overview";
import { useOpenRun } from "~/hooks/use-open-run";

const BoardRoute = () => {
  const { repository } = Route.useParams();
  const { data } = useSuspenseQuery(overviewQuery());
  const desk = useSuspenseQuery(deskQuery());
  const openRun = useOpenRun();
  const project = data.projects.find((candidate) => candidate.repository === repository);
  // A refetch after the loader ran can remove the project.
  if (project === undefined) return <ProjectNotFound />;
  return (
    <ProjectBoard
      project={project}
      loops={data.loops}
      stalled={desk.data.notMoving}
      disabled={data._tag === "NeedsSetup"}
      openRun={openRun}
    />
  );
};

export const Route = createFileRoute("/projects/$owner/$name/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(deskQuery()),
  pendingComponent: RoutePending,
  errorComponent: RouteError,
  component: BoardRoute,
});
