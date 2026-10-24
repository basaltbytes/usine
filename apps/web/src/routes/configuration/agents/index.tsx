import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AgentsList } from "../../../configuration/agents.tsx";
import { configurationQuery } from "../../../configuration/query.ts";

const Agents = () => {
  const { data } = useSuspenseQuery(configurationQuery());
  return <AgentsList configuration={data} />;
};

export const Route = createFileRoute("/configuration/agents/")({ component: Agents });
