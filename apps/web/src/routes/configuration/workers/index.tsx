import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { configurationQuery } from "../../../configuration/query.ts";
import { WorkersList } from "../../../configuration/workers.tsx";

const Workers = () => {
  const { data } = useSuspenseQuery(configurationQuery());
  return <WorkersList configuration={data} />;
};

export const Route = createFileRoute("/configuration/workers/")({ component: Workers });
