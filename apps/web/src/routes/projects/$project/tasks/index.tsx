import { useSuspenseQuery } from "@tanstack/react-query";
import { RepositoryName } from "@usine/core/repository";
import { Schema } from "effect";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { RouteError, RoutePending } from "~/components/route-status";
import { ProjectNotFound } from "~/components/project-not-found";
import { deskQuery } from "~/lib/desk/queries";
import { overviewQuery, projectId, projectForRepository } from "~/lib/overview";
import { TaskList } from "~/features/tasks/list.page";

const TasksRoute = () => {
  const { project: slug } = Route.useParams();
  const { data } = useSuspenseQuery(overviewQuery());
  const { repository } = Route.useSearch();
  const navigate = Route.useNavigate();
  const desk = useSuspenseQuery(deskQuery());
  const project = data.projects.find((entry) => projectId(entry) === slug);
  // A refetch after the loader ran can remove the project.
  if (project === undefined) return <ProjectNotFound />;
  return (
    <TaskList
      project={project}
      stalled={desk.data.notMoving}
      repository={repository}
      onRepositoryChange={(repository) =>
        void navigate({ search: (previous) => ({ ...previous, repository }) })
      }
    />
  );
};

export const Route = createFileRoute("/projects/$project/tasks/")({
  validateSearch: Schema.toStandardSchemaV1(
    Schema.Struct({ repository: Schema.optional(RepositoryName) }),
  ),
  loader: async ({ context, params, location }) => {
    const [overview] = await Promise.all([
      context.queryClient.ensureQueryData(overviewQuery()),
      context.queryClient.ensureQueryData(deskQuery()),
    ]);
    if (!overview.projects.some((project) => projectId(project) === params.project)) {
      const legacy = projectForRepository(
        overview.projects,
        RepositoryName.make(`${params.project}/tasks`),
      );
      if (legacy !== undefined)
        throw redirect({
          to: "/projects/$project",
          params: { project: projectId(legacy) },
          search: location.search,
          replace: true,
        });
    }
  },
  pendingComponent: RoutePending,
  errorComponent: RouteError,
  component: TasksRoute,
});
