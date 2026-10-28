import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { configurationQuery } from "~/lib/configuration/queries";
import { WorkersList } from "~/features/configuration/components/workers/list";

const Workers = () => {
  const { data } = useSuspenseQuery(configurationQuery());
  return <WorkersList configuration={data} />;
};

export const Route = createFileRoute("/configuration/workers/")({ component: Workers });
