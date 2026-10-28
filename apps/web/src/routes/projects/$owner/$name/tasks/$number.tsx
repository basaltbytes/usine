import { createFileRoute, notFound } from "@tanstack/react-router";
import { ItemNumber } from "@usine/core/item";
import { OperatorHttpError } from "@usine/orchestrator/operator/http";
import { Option, Schema } from "effect";
import { RouteError, RoutePending } from "~/components/route-status";
import { TaskPage } from "~/features/tasks/task.page";
import { TaskNotFound } from "~/features/tasks/components/not-found";
import { taskQuery } from "~/features/tasks/queries";

const decodeNumber = Schema.decodeUnknownOption(
  Schema.FiniteFromString.pipe(Schema.decodeTo(ItemNumber)),
);

const TaskRoute = () => {
  const { repository } = Route.useParams();
  const { number } = Route.useLoaderData();
  return <TaskPage key={`${repository}#${number}`} repository={repository} number={number} />;
};

const MissingTask = () => {
  const { repository, number } = Route.useParams();
  return <TaskNotFound repository={repository} number={number} />;
};

export const Route = createFileRoute("/projects/$owner/$name/tasks/$number")({
  loader: async ({ context, params }) => {
    const number = decodeNumber(params.number);
    if (Option.isNone(number)) throw notFound();
    try {
      await context.queryClient.ensureQueryData(taskQuery(params.repository, number.value));
    } catch (error) {
      if (error instanceof OperatorHttpError && error.error === "BoardItemNotFoundError")
        throw notFound();
      throw error;
    }
    return { number: number.value };
  },
  pendingComponent: RoutePending,
  errorComponent: RouteError,
  notFoundComponent: MissingTask,
  component: TaskRoute,
});
