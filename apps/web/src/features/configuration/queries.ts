import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { LoopName } from "@usine/core/loop";
import { api } from "~/lib/api";
import { configurationQuery } from "~/lib/configuration/queries";
import { overviewQuery } from "~/lib/overview";

const UPGRADE_REFRESH_MS = 5_000;

export const usePauseLoop = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ loop, paused }: { readonly loop: LoopName; readonly paused: boolean }) =>
      api((client) => client[paused ? "unpause" : "pause"]({ params: { loop } })),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: configurationQuery().queryKey }),
        queryClient.invalidateQueries({ queryKey: overviewQuery().queryKey }),
      ]),
  });
};

export const upgradeQuery = () =>
  queryOptions({
    queryKey: ["upgrade"] as const,
    queryFn: () => api((client) => client.upgradeStatus({})),
    refetchInterval: UPGRADE_REFRESH_MS,
    retry: 3,
  });
