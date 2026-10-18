import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AttemptId } from "@usine/core/attempt";
import type { RunId } from "@usine/core/run";
import { api } from "./api.ts";

/** An operator decision on one Run; resolving a failure names the failed Attempt it answers. */
export type RunActionRequest =
  | { readonly action: "approve" | "retry" | "cancel" }
  | { readonly action: "resolveFailure"; readonly attemptId: AttemptId };

/** Sends Run actions from any screen; success refreshes the overview and that Run's detail. */
export const useRunAction = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      runId,
      request,
    }: {
      readonly runId: RunId;
      readonly request: RunActionRequest;
    }) =>
      api((client) =>
        request.action === "resolveFailure"
          ? client.resolveFailure({ params: { runId }, payload: { attemptId: request.attemptId } })
          : client[request.action]({ params: { runId } }),
      ),
    onSuccess: (_, { runId }) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
        queryClient.invalidateQueries({ queryKey: ["run", runId] }),
      ]),
  });
};

/** The pending state and last error of a screen's Run actions. */
export type RunActions = ReturnType<typeof useRunAction>;
