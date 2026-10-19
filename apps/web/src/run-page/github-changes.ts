import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { RunView } from "@usine/orchestrator/operator";
import { api } from "../api.ts";

// How often a live Attempt's GitHub changes are read again; GitHub is asked each time.
const LIVE_REFRESH_MILLIS = 30_000;

/**
 * What each of the Run's Attempts changed on its GitHub Item. The Run page asks when it
 * opens, again when an Attempt starts or ends, and every 30 seconds while one runs; the
 * Run's detail poll never asks.
 */
export const useRunGitHubChanges = (run: Pick<RunView, "id" | "attempts">) => {
  const ended = run.attempts.filter(({ outcome }) => outcome !== null).length;
  const live = ended < run.attempts.length;
  return useQuery({
    queryKey: ["run-github-changes", run.id, run.attempts.length, ended],
    queryFn: () => api((client) => client.githubChanges({ params: { runId: run.id } })),
    placeholderData: keepPreviousData,
    staleTime: LIVE_REFRESH_MILLIS,
    refetchInterval: live ? LIVE_REFRESH_MILLIS : false,
    retry: 1,
  });
};
