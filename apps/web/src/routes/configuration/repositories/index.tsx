import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { configurationQuery } from "~/features/configuration/queries";
import { RepositoriesList } from "~/features/configuration/components/repositories";

const Repositories = () => {
  const { data } = useSuspenseQuery(configurationQuery());
  return <RepositoriesList configuration={data} />;
};

export const Route = createFileRoute("/configuration/repositories/")({ component: Repositories });
