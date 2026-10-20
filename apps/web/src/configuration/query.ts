import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { LoopName } from "@usine/core/loop";
import { api } from "../api.ts";

const CONFIGURATION_REFRESH_MS = 5_000;

/** The instance folder as the orchestrator parsed it, with its runtime state; every Configuration
 * page reads it. Slots and preflights change while Attempts run, so it refreshes on its own. */
export const configurationQuery = () => ({
  queryKey: ["configuration"] as const,
  queryFn: () => api((client) => client.configuration()),
  refetchInterval: CONFIGURATION_REFRESH_MS,
});

/** Pauses or resumes a Loop, then refreshes the configuration and the overview that both show it. */
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
