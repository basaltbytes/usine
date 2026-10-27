import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ProjectNotFound } from "~/components/project-not-found";
import { deskQuery } from "~/lib/desk/queries";
import { overviewQuery } from "~/lib/overview";
import { TaskList } from "~/features/tasks/list.page";

const TasksRoute = () => {
  const { repository } = Route.useParams();
  const { data } = useSuspenseQuery(overviewQuery());
  const desk = useQuery(deskQuery());
  const project = data.projects.find((candidate) => candidate.repository === repository);
  // A refetch after the loader ran can remove the project.
  if (project === undefined) return <ProjectNotFound />;
  return <TaskList project={project} stalled={desk.data?.notMoving ?? []} />;
};

export const Route = createFileRoute("/projects/$owner/$name/tasks/")({
  component: TasksRoute,
});
