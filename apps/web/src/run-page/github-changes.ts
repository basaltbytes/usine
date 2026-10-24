import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { RunView } from "@usine/orchestrator/operator";
import { api } from "../api.ts";

// The refetch interval while an Attempt runs; each refetch calls GitHub.
const LIVE_REFRESH_MILLIS = 30_000;

/**
 * Returns the changes each Attempt made on the Run's GitHub Item. Fetches on mount, when an Attempt
 * starts or ends, and every 30 seconds while one runs; the Run detail poll does not fetch them.
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
