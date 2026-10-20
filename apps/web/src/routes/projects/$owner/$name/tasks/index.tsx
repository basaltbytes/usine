import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ProjectNotFound } from "@/components/project-not-found";
import { deskQuery } from "../../../../../desk/query.ts";
import { overviewQuery } from "../../../../../overview.ts";
import { TaskList } from "../../../../../task/list.tsx";

const TasksRoute = () => {
  const { repository } = Route.useParams();
  const { data } = useSuspenseQuery(overviewQuery());
  const desk = useQuery(deskQuery());
  const project = data.projects.find((candidate) => candidate.repository === repository);
  // A live refetch can drop the project after the loader admitted it.
  if (project === undefined) return <ProjectNotFound />;
  return <TaskList project={project} stalled={desk.data?.notMoving ?? []} />;
};

export const Route = createFileRoute("/projects/$owner/$name/tasks/")({
  component: TasksRoute,
});
