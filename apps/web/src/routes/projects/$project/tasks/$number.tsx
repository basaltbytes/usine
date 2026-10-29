import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { ItemNumber } from "@usine/core/item";
import { RepositoryName } from "@usine/core/repository";
import { OperatorHttpError } from "@usine/orchestrator/operator/http";
import { Option, Schema } from "effect";
import { RouteError, RoutePending } from "~/components/route-status";
import { TaskPage } from "~/features/tasks/task.page";
import { TaskNotFound } from "~/features/tasks/components/not-found";
import { taskQuery } from "~/features/tasks/queries";
import { overviewQuery, projectId, projectForRepository } from "~/lib/overview";

const decodeNumber = Schema.decodeUnknownOption(
  Schema.FiniteFromString.pipe(Schema.decodeTo(ItemNumber)),
);
const TaskRoute = () => {
  const { repository, number } = Route.useLoaderData();
  return <TaskPage key={`${repository}#${number}`} repository={repository} number={number} />;
};
const MissingTask = () => {
  const { repository } = Route.useSearch();
  const { number } = Route.useParams();
  return repository === undefined ? (
    <p>Task not found</p>
  ) : (
    <TaskNotFound repository={repository} number={number} />
  );
};
export const Route = createFileRoute("/projects/$project/tasks/$number")({
  beforeLoad: async ({ context, params, location }) => {
    if (params.number !== "tasks") return;
    const overview = await context.queryClient.ensureQueryData(overviewQuery());
    if (overview.projects.some((project) => projectId(project) === params.project)) return;
    const repository = RepositoryName.make(`${params.project}/tasks`);
    const project = projectForRepository(overview.projects, repository);
    if (project !== undefined)
      throw redirect({
        to: "/projects/$project/tasks",
        params: { project: projectId(project) },
        search: { ...location.search, repository },
        replace: true,
      });
  },
  validateSearch: Schema.toStandardSchemaV1(
    Schema.Struct({ repository: Schema.optional(RepositoryName) }),
  ),
  loaderDeps: ({ search }) => ({ repository: search.repository }),
  loader: async ({ context, params, deps }) => {
    const number = decodeNumber(params.number);
    const overview = await context.queryClient.ensureQueryData(overviewQuery());
    const project = overview.projects.find((entry) => projectId(entry) === params.project);
    const repository =
      deps.repository ??
      (project?.repositories.length === 1
        ? project.repositories[0]
        : project?.repositories.length === 0
          ? project.repository
          : undefined);
    if (
      Option.isNone(number) ||
      project === undefined ||
      repository === undefined ||
      projectForRepository(overview.projects, repository) !== project
    )
      throw notFound();
    try {
      await context.queryClient.ensureQueryData(taskQuery(repository, number.value));
    } catch (error) {
      if (error instanceof OperatorHttpError && error.error === "BoardItemNotFoundError")
        throw notFound();
      throw error;
    }
    return { number: number.value, repository };
  },
  pendingComponent: RoutePending,
  errorComponent: RouteError,
  notFoundComponent: MissingTask,
  component: TaskRoute,
});
