import { changes } from "~/lib/query-changes";
import { queryOptions } from "@tanstack/react-query";
import { api } from "~/lib/api";

export const configurationQuery = () =>
  queryOptions({
    queryKey: ["configuration"] as const,
    queryFn: () => api((client) => client.configuration()),
    meta: { refreshLabel: "Configuration", changes: changes.kind("configuration", "worker") },
    staleTime: 60_000,
  });

export const agentsQuery = () =>
  queryOptions({
    queryKey: ["agents"] as const,
    staleTime: 60_000,
    meta: { refreshLabel: "Agents", changes: changes.kind("configuration") },
    queryFn: () => api((client) => client.agents()),
  });
