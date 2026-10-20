import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Schema } from "effect";
import { ProjectNotFound } from "@/components/project-not-found";
import { deskQuery } from "../../../../../desk/query.ts";
import { overviewQuery } from "../../../../../overview.ts";
import { TaskList } from "../../../../../task/list.tsx";

/** `?done=1` adds the Tasks whose current Item is closed, so going back to the list keeps them. */
const TasksSearch = Schema.toStandardSchemaV1(
  Schema.Struct({ done: Schema.optional(Schema.Literal(1)) }),
);

const TasksRoute = () => {
  const { repository } = Route.useParams();
  const { done } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data } = useSuspenseQuery(overviewQuery());
  const desk = useQuery(deskQuery());
  const project = data.projects.find((candidate) => candidate.repository === repository);
  // A live refetch can drop the project after the loader admitted it.
  if (project === undefined) return <ProjectNotFound />;
  return (
    <TaskList
      project={project}
      stalled={desk.data?.notMoving ?? []}
      showDone={done === 1}
      onShowDone={(show) =>
        void navigate({
          search: (previous) => ({ ...previous, done: show ? 1 : undefined }),
          replace: true,
        })
      }
    />
  );
};

export const Route = createFileRoute("/projects/$owner/$name/tasks/")({
  validateSearch: TasksSearch,
  component: TasksRoute,
});
