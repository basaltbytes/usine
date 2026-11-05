import { changes } from "~/lib/query-changes";
import { queryOptions } from "@tanstack/react-query";
import { ProviderStatus } from "@usine/gateway/credentials";
import { authRequest } from "~/lib/auth";

export const providersQuery = () =>
  queryOptions({
    queryKey: ["provider-connections"],
    queryFn: () => authRequest("/api/providers", ProviderStatus),
    refetchInterval: (query) =>
      query.state.data?.logins.some(
        ({ state }) => state.status === "starting" || state.status === "authorizing",
      ) === true
        ? 2000
        : 60000,
    meta: {
      refreshLabel: "Provider connections",
      changes: changes.kind("configuration", "worker"),
    },
  });
