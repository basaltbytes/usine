import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { RouteError, RoutePending } from "~/components/route-status";
import { ProjectNotFound } from "~/components/project-not-found";
import { deskQuery } from "~/lib/desk/queries";
import { overviewQuery, projectForRepository } from "~/lib/overview";
import { TaskList } from "~/features/tasks/list.page";

const TasksRoute = () => {
  const { repository } = Route.useParams();
  const { data } = useSuspenseQuery(overviewQuery());
  const desk = useSuspenseQuery(deskQuery());
  const project = projectForRepository(data.projects, repository);
  // A refetch after the loader ran can remove the project.
  if (project === undefined) return <ProjectNotFound />;
  return <TaskList project={project} stalled={desk.data.notMoving} />;
};

export const Route = createFileRoute("/projects/$owner/$name/tasks/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(deskQuery()),
  pendingComponent: RoutePending,
  errorComponent: RouteError,
  component: TasksRoute,
});
