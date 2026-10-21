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
import { api } from "./api.ts";

/** An operator decision on one Run; resolving a failure names the failed Attempt it answers. */
export type RunActionRequest =
  | { readonly action: "approve" | "retry" | "cancel" }
  | { readonly action: "resolveFailure"; readonly attemptId: AttemptId };

/** One Run action as a screen sends it. */
interface RunActionVariables {
  readonly runId: RunId;
  readonly request: RunActionRequest;
}

// Files every screen's Run actions in the mutation cache, so any screen can see one in flight.
const runActionKey = ["run-action"] as const;

/** `overview` without its Needs you entries about `runId`, which an action on that Run answered. */
const withoutRunNeeds = (overview: FactoryOverview, runId: RunId): FactoryOverview => {
  const needsYou = overview.needsYou.filter((need) => !("runId" in need) || need.runId !== runId);
  return overview._tag === "Ready"
    ? new ReadyOverview({ ...overview, needsYou })
    : new NeedsSetupOverview({ ...overview, needsYou });
};

/**
 * Whether `error` is the server refusing a Run action because the Run's state no longer allows it,
 * such as approving a Run another screen has approved: the screen that sent it showed the Run stale.
 */
export const isRunOperationRejected = (error: Error): boolean =>
  error instanceof OperatorHttpError && error.error === "RunOperationRejectedError";

const useRefreshRun = () => {
  const queryClient = useQueryClient();
  return (runId: RunId) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["overview"] }),
      queryClient.invalidateQueries({ queryKey: ["desk"] }),
      queryClient.invalidateQueries({ queryKey: ["run", runId] }),
    ]);
};

/**
 * Sends Run actions from any screen. Success drops the Run's Needs you entries from the cached
 * overview at once, then refreshes the overview, the desk, and that Run's detail; the request
 * stays pending until that refresh lands, for `usePendingRunAction` too. A refusal that
 * `isRunOperationRejected` recognizes refreshes them the same way before the request fails.
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
      // The overview can take seconds to answer the refresh; until then Needs you would still
      // offer the action the server has just taken. The refresh cancels any overview request in
      // flight, so an answer sent before this action cannot bring the entries back.
      queryClient.setQueryData<FactoryOverview>(["overview"], (overview) =>
        overview === undefined ? overview : withoutRunNeeds(overview, runId),
      );
      return refresh(runId);
    },
    onError: (error, { runId }) => (isRunOperationRejected(error) ? refresh(runId) : undefined),
  });
};

/** The pending state and last error of a screen's Run actions. */
export type RunActions = ReturnType<typeof useRunAction>;

/**
 * The action that any screen is sending on Run `runId` through `useRunAction`, until the refresh
 * after it lands; undefined while none is. The latest wins when several are pending.
 */
export const usePendingRunAction = (runId: RunId): RunActionRequest["action"] | undefined =>
  useMutationState<MutationState<unknown, Error, RunActionVariables>>({
    filters: { mutationKey: runActionKey, status: "pending" },
    select: ({ state }) => state,
  })
    .filter(({ variables }) => variables?.runId === runId)
    .at(-1)?.variables?.request.action;

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
