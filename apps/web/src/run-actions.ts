import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type AttemptId, AttemptTask } from "@usine/core/attempt";
import type { RunId } from "@usine/core/run";
import { EditAndRetry, type RunView } from "@usine/orchestrator/operator";
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
      queryClient.invalidateQueries({ queryKey: ["desk"] }),
      queryClient.invalidateQueries({ queryKey: ["run", runId] }),
    ]);
};

/** Sends Run actions from any screen; success refreshes the overview, the desk, and that Run's detail. */
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

/** Running `run` again with the task and Agent it ran with, as Run again does without the editor. */
export const unchangedRunAgain = (run: RunView) => ({
  runId: run.id,
  amendment: new EditAndRetry({ task: AttemptTask.make(run.task), agent: run.agent }),
});

/**
 * Opens a new Run for the Item state of a succeeded or canceled Run, from any screen, with the
 * task and roster Agent `amendment` names. Success refreshes the overview, the desk, and that
 * Run's detail; the result names the new Run, or the cycle-budget Ask that blocked it.
 */
export const useRunAgain = () => {
  const refresh = useRefreshRun();
  return useMutation({
    mutationFn: ({
      runId,
      amendment,
    }: {
      readonly runId: RunId;
      readonly amendment: EditAndRetry;
    }) => api((client) => client.runAgain({ params: { runId }, payload: amendment })),
    onSuccess: (_, { runId }) => refresh(runId),
  });
};
