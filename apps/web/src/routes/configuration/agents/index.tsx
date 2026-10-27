import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AgentsList } from "~/features/configuration/components/agents";
import { configurationQuery } from "~/features/configuration/queries";

const Agents = () => {
  const { data } = useSuspenseQuery(configurationQuery());
  return <AgentsList configuration={data} />;
};

export const Route = createFileRoute("/configuration/agents/")({ component: Agents });
