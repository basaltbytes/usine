import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { configurationQuery } from "../../../configuration/query.ts";
import { RepositoriesList } from "../../../configuration/repositories.tsx";

const Repositories = () => {
  const { data } = useSuspenseQuery(configurationQuery());
  return <RepositoriesList configuration={data} />;
};

export const Route = createFileRoute("/configuration/repositories/")({ component: Repositories });
