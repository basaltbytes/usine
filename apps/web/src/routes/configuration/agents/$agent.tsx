import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AgentDetail } from "~/features/configuration/components/agents";
import { configurationQuery } from "~/lib/configuration/queries";

const Agent = () => {
  const { agent } = Route.useParams();
  const { data } = useSuspenseQuery(configurationQuery());
  return <AgentDetail name={agent} configuration={data} />;
};

export const Route = createFileRoute("/configuration/agents/$agent")({ component: Agent });
