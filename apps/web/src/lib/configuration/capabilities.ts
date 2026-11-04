import { queryOptions, useQuery } from "@tanstack/react-query";
import type { Harness } from "@usine/core/agent/brain";
import { api } from "~/lib/api";

export const capabilitiesQuery = () =>
  queryOptions({
    queryKey: ["configuration-capabilities"],
    queryFn: () => api((client) => client.configurationCapabilities({})),
    staleTime: Infinity,
  });

export const useHarnessLabel = () => {
  const { data } = useQuery(capabilitiesQuery());
  return (id: Harness): string =>
    data?.harnessDetails.find((descriptor) => descriptor.id === id)?.label ?? id;
};
