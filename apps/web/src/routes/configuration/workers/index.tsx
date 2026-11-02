import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { workersQuery } from "~/features/configuration/queries";
import { configurationQuery } from "~/lib/configuration/queries";
import { WorkersList } from "~/features/configuration/components/workers/list";

const Workers = () => {
  const { data } = useSuspenseQuery(workersQuery());
  return <WorkersList configuration={data} />;
};

export const Route = createFileRoute("/configuration/workers/")({
  loader: ({ context }) => {
    const cached = context.queryClient.getQueryData(configurationQuery().queryKey);
    return context.queryClient.ensureQueryData(
      cached === undefined ? workersQuery() : { ...workersQuery(), initialData: cached },
    );
  },
  component: Workers,
});
