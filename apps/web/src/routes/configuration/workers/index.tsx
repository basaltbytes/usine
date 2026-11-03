import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { workersQuery } from "~/features/configuration/queries";
import { WorkersList } from "~/features/configuration/components/workers/list";

const Workers = () => {
  const { data } = useSuspenseQuery(workersQuery());
  return <WorkersList configuration={data} />;
};

export const Route = createFileRoute("/configuration/workers/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(workersQuery()),
  component: Workers,
});
