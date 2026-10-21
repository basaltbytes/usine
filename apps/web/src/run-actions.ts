import { type MutationKey, useMutation, useQueryClient } from "@tanstack/react-query";
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
 *
 * `mutationKey` files the requests in the mutation cache, so a component that remounts while one
 * is in flight can read it back with `useMutationState`. `onClaimed` receives the new Run's id
 * after the refresh, even when the component that sent the request has unmounted since; a
 * callback passed to `mutate` is dropped then.
 */
export const useRunAgain = ({
  mutationKey = ["run-again"],
  onClaimed,
}: {
  readonly mutationKey?: MutationKey;
  readonly onClaimed?: (runId: RunId) => void;
} = {}) => {
  const refresh = useRefreshRun();
  return useMutation({
    mutationKey,
    mutationFn: ({
      runId,
      amendment,
    }: {
      readonly runId: RunId;
      readonly amendment: EditAndRetry;
    }) => api((client) => client.runAgain({ params: { runId }, payload: amendment })),
    onSuccess: async (result, { runId }) => {
      await refresh(runId);
      if (result._tag === "Claimed") onClaimed?.(result.runId);
    },
  });
};
