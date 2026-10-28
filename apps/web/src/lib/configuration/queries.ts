import { queryOptions } from "@tanstack/react-query";
import { api } from "~/lib/api";

const CONFIGURATION_REFRESH_MS = 5_000;

export const configurationQuery = () =>
  queryOptions({
    queryKey: ["configuration"] as const,
    queryFn: () => api((client) => client.configuration()),
    refetchInterval: CONFIGURATION_REFRESH_MS,
  });

export const agentsQuery = () =>
  queryOptions({
    queryKey: ["agents"] as const,
    queryFn: () => api((client) => client.agents()),
  });
