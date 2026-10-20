import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AgentDetail } from "../../../configuration/agents.tsx";
import { configurationQuery } from "../../../configuration/query.ts";

const Agent = () => {
  const { agent } = Route.useParams();
  const { data } = useSuspenseQuery(configurationQuery());
  return <AgentDetail name={agent} configuration={data} />;
};

export const Route = createFileRoute("/configuration/agents/$agent")({ component: Agent });
