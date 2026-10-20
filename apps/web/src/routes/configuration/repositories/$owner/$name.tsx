import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { configurationQuery } from "../../../../configuration/query.ts";
import { RepositoryDetail } from "../../../../configuration/repositories.tsx";

const Repository = () => {
  const { owner, name } = Route.useParams();
  const { data } = useSuspenseQuery(configurationQuery());
  return <RepositoryDetail owner={owner} name={name} configuration={data} />;
};

export const Route = createFileRoute("/configuration/repositories/$owner/$name")({
  component: Repository,
});
