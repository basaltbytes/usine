import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { configurationQuery } from "../../../configuration/query.ts";
import { WorkerDetail } from "../../../configuration/workers.tsx";

const Worker = () => {
  const { worker } = Route.useParams();
  const { data } = useSuspenseQuery(configurationQuery());
  return <WorkerDetail name={worker} configuration={data} />;
};

export const Route = createFileRoute("/configuration/workers/$worker")({ component: Worker });
