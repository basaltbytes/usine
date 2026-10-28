import {
  type MutationKey,
  type MutationState,
  useMutation,
  useMutationState,
  useQueryClient,
} from "@tanstack/react-query";
import { type AttemptId, AttemptTask } from "@usine/core/attempt";
import type { RunId } from "@usine/core/run";
import {
  EditAndRetry,
  type FactoryOverview,
  NeedsSetupOverview,
  ReadyOverview,
  type RunView,
} from "@usine/orchestrator/operator";
import { OperatorHttpError } from "@usine/orchestrator/operator/http";
import { overviewQuery } from "~/lib/overview";
import { deskQuery } from "~/lib/desk/queries";
import { runDetailKey } from "~/lib/runs/queries";
import { api } from "~/lib/api";

/** An operator action on one Run; resolving a failure includes the failed Attempt. */
export type RunActionRequest =
  | { readonly action: "approve" | "retry" | "cancel" }
  | { readonly action: "resolveFailure"; readonly attemptId: AttemptId };

interface RunActionVariables {
  readonly runId: RunId;
  readonly request: RunActionRequest;
}

// The mutation key of all Run actions, so any screen can see one in flight.
const runActionKey = ["run-action"] as const;

const withoutRunNeeds = (overview: FactoryOverview, runId: RunId): FactoryOverview => {
  const needsYou = overview.needsYou.filter((need) => !("runId" in need) || need.runId !== runId);
  return overview._tag === "Ready"
    ? new ReadyOverview({ ...overview, needsYou })
    : new NeedsSetupOverview({ ...overview, needsYou });
};

/**
 * Returns whether the server rejected a Run action because the Run's state no longer allows it, for
 * example approving a Run that another screen already approved.
 */
export const isRunOperationRejected = (error: Error): boolean =>
  error instanceof OperatorHttpError && error.error === "RunOperationRejectedError";

const useRefreshRun = () => {
  const queryClient = useQueryClient();
  return (runId: RunId) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: overviewQuery().queryKey }),
      queryClient.invalidateQueries({ queryKey: deskQuery().queryKey }),
      queryClient.invalidateQueries({ queryKey: runDetailKey(runId) }),
    ]);
};

/**
 * Sends Run actions. On success, removes the Run's Needs you entries from the cached overview, then
 * refetches the overview, desk, and Run detail; the mutation stays pending until the refetch ends.
 * An error that `isRunOperationRejected` matches triggers the same refetch.
 */
export const useRunAction = () => {
  const queryClient = useQueryClient();
  const refresh = useRefreshRun();
  return useMutation({
    mutationKey: runActionKey,
    mutationFn: ({ runId, request }: RunActionVariables) =>
      api((client) =>
        request.action === "resolveFailure"
          ? client.resolveFailure({ params: { runId }, payload: { attemptId: request.attemptId } })
          : client[request.action]({ params: { runId } }),
      ),
    onSuccess: (_, { runId }) => {
      // The overview refetch can take seconds; until then Needs you would still offer the action.
      // The refetch cancels overview requests in flight, so an older response cannot restore them.
      queryClient.setQueryData<FactoryOverview>(overviewQuery().queryKey, (overview) =>
        overview === undefined ? overview : withoutRunNeeds(overview, runId),
      );
      return refresh(runId);
    },
    onError: (error, { runId }) => (isRunOperationRejected(error) ? refresh(runId) : undefined),
  });
};

export type RunActions = ReturnType<typeof useRunAction>;

/**
 * Returns the action that any screen is sending on `runId`, until its refetch ends, or `undefined`.
 * If several are pending, returns the latest.
 */
export const usePendingRunAction = (runId: RunId): RunActionRequest["action"] | undefined =>
  useMutationState<MutationState<unknown, Error, RunActionVariables>>({
    filters: { mutationKey: runActionKey, status: "pending" },
    select: ({ state }) => state,
  })
    .filter(({ variables }) => variables?.runId === runId)
    .at(-1)?.variables?.request.action;

export const unchangedRunAgain = (run: RunView) => ({
  runId: run.id,
  amendment: new EditAndRetry({ task: AttemptTask.make(run.task), agent: run.agent }),
});

/**
 * Opens a new Run for the Item of a succeeded or canceled Run, with the task and Agent in
 * `amendment`. On success, refetches the overview, desk, and Run detail; the result is the new Run
 * or the cycle budget Ask that blocked it. `mutationKey` lets a remounted component read pending
 * requests with `useMutationState`. `onClaimed` is called with the new Run's ID after the refetch,
 * even if the sending component has unmounted.
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
