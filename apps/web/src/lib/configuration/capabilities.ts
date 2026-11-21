import { queryOptions, useQuery } from "@tanstack/react-query";
import type { Harness } from "@usine/core/agent/brain";
import type { BillingPool } from "@usine/core/agent/pool";
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

/** Returns a billing pool's label, or its ID before the labels load or for an undeclared pool. */
export const usePoolLabel = () => {
  const { data } = useQuery(capabilitiesQuery());
  return (id: BillingPool): string => data?.pools.find((pool) => pool.id === id)?.label ?? id;
};
