import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { configurationQuery } from "~/features/configuration/queries";
import { WorkerDetail } from "~/features/configuration/components/workers/detail";

const Worker = () => {
  const { worker } = Route.useParams();
  const { data } = useSuspenseQuery(configurationQuery());
  return <WorkerDetail name={worker} configuration={data} />;
};

export const Route = createFileRoute("/configuration/workers/$worker")({ component: Worker });
