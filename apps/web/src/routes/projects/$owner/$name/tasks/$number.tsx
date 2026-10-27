import { createFileRoute } from "@tanstack/react-router";
import { TaskPage } from "~/features/tasks/task.page";

const TaskRoute = () => {
  const { repository, number } = Route.useParams();
  return <TaskPage key={`${repository}#${number}`} repository={repository} number={number} />;
};

export const Route = createFileRoute("/projects/$owner/$name/tasks/$number")({
  component: TaskRoute,
});
