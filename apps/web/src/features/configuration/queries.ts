import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { LoopName } from "@usine/core/loop";
import { api } from "~/lib/api";

const CONFIGURATION_REFRESH_MS = 5_000;

export const configurationQuery = () => ({
  queryKey: ["configuration"] as const,
  queryFn: () => api((client) => client.configuration()),
  refetchInterval: CONFIGURATION_REFRESH_MS,
});

export const usePauseLoop = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ loop, paused }: { readonly loop: LoopName; readonly paused: boolean }) =>
      api((client) => client[paused ? "unpause" : "pause"]({ params: { loop } })),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["configuration"] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
      ]),
  });
};

export const upgradeQuery = () => ({
  queryKey: ["upgrade"] as const,
  queryFn: () => api((client) => client.upgradeStatus({})),
  refetchInterval: CONFIGURATION_REFRESH_MS,
  retry: 3,
});
