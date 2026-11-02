import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import type { RunView } from "@usine/orchestrator/operator";
import { api } from "~/lib/api";

const LIVE_REFRESH_MILLIS = 30_000;

/**
 * Returns the changes each Attempt made on the Run's GitHub Item. Fetches on mount, when an Attempt
 * starts or ends, and when a change notice identifies the run.
 */
export const runGitHubChangesQuery = (run: Pick<RunView, "id" | "attempts">) => {
  const ended = run.attempts.filter(({ outcome }) => outcome !== null).length;
  return queryOptions({
    queryKey: ["run-github-changes", run.id, run.attempts.length, ended],
    queryFn: () => api((client) => client.githubChanges({ params: { runId: run.id } })),
    placeholderData: keepPreviousData,
    staleTime: LIVE_REFRESH_MILLIS,
    meta: { refreshLabel: "GitHub changes" },
    retry: 1,
  });
};
