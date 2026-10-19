import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AttemptId } from "@usine/core/attempt";
import type { RunId } from "@usine/core/run";
import type { EditAndRetry } from "@usine/orchestrator/operator";
import { api } from "./api.ts";

/** An operator decision on one Run; resolving a failure names the failed Attempt it answers. */
export type RunActionRequest =
  | { readonly action: "approve" | "retry" | "cancel" }
  | { readonly action: "resolveFailure"; readonly attemptId: AttemptId };

const useRefreshRun = () => {
  const queryClient = useQueryClient();
  return (runId: RunId) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["overview"] }),
      queryClient.invalidateQueries({ queryKey: ["run", runId] }),
    ]);
};

/** Sends Run actions from any screen; success refreshes the overview and that Run's detail. */
export const useRunAction = () => {
  const refresh = useRefreshRun();
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
    onSuccess: (_, { runId }) => refresh(runId),
  });
};

/** The pending state and last error of a screen's Run actions. */
export type RunActions = ReturnType<typeof useRunAction>;

/**
 * Opens a new Run for the Item state of a succeeded or canceled Run, with the given task and
 * roster Agent. Success refreshes the overview and the Run's detail; the result names the new
 * Run, or the cycle-budget Ask that blocked it.
 */
export const useRunAgain = (runId: RunId) => {
  const refresh = useRefreshRun();
  return useMutation({
    mutationFn: (amendment: EditAndRetry) =>
      api((client) => client.runAgain({ params: { runId }, payload: amendment })),
    onSuccess: () => refresh(runId),
  });
};
