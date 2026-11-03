import { changes } from "~/lib/query-changes";
import { queryOptions } from "@tanstack/react-query";
import { api } from "~/lib/api";

export const deskQuery = () =>
  queryOptions({
    queryKey: ["desk"] as const,
    queryFn: () => api((client) => client.desk()),
    staleTime: 30_000,
    meta: { refreshLabel: "Activity", changes: changes.kind("worker", "activity") },
  });
