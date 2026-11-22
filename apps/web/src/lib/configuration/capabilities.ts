import { queryOptions, useQuery } from "@tanstack/react-query";
import type { Harness } from "@usine/core/agent/brain";
import { type BillingPool, declaredPool } from "@usine/core/agent/pool";
import { Option } from "effect";
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

/**
 * Returns a billing pool's label, its ID for an undeclared pool or if the labels fail to load, or
 * `None` while they load.
 */
export const usePoolLabel = () => {
  const { data, isPending } = useQuery(capabilitiesQuery());
  return (id: BillingPool): Option.Option<string> =>
    isPending ? Option.none() : Option.some(declaredPool(data?.pools ?? [], id).label);
};
