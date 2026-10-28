import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { LoopName } from "@usine/core/loop";
import { api } from "~/lib/api";
import { configurationQuery } from "~/lib/configuration/queries";
import { overviewQuery } from "~/lib/overview";

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
