import { queryOptions, type QueryClient } from "@tanstack/react-query";
import type { RunId } from "@usine/core/run";
import {
  ColdTranscriptRequest,
  RunDetailView,
  TailTranscriptRequest,
} from "@usine/orchestrator/operator";
import { api } from "~/lib/api";
import { mergeTranscript, RUN_DETAIL_CACHE_STRUCTURAL_SHARING } from "~/lib/runs/transcript/cache";
import { fetchRunDetail } from "~/lib/runs/transcript/fetch";

export const runDetailKeys = ["run"] as const;
export const runDetailKey = (runId: RunId) => [...runDetailKeys, runId] as const;

export const runDetailQuery = (queryClient: QueryClient, runId: RunId) => {
  const key = runDetailKey(runId);
  return queryOptions({
    queryKey: key,
    queryFn: async () => {
      const previous = queryClient.getQueryData<RunDetailView>(key);
      const cursor = previous?.transcript.at(-1)?.sequence;
      const next = await fetchRunDetail(
        cursor === undefined
          ? new ColdTranscriptRequest()
          : new TailTranscriptRequest({ after: cursor }),
        (query) => api((client) => client.detail({ params: { runId }, query })),
      );
      const current = queryClient.getQueryData<RunDetailView>(key);
      if (cursor === undefined || current === undefined) return next;
      return new RunDetailView({
        ...next,
        transcript: mergeTranscript(current.transcript, next.transcript),
        earlierTranscript: current.earlierTranscript,
      });
    },
    staleTime: 1_000,
    structuralSharing: RUN_DETAIL_CACHE_STRUCTURAL_SHARING,
    meta: { refreshLabel: "Run" },
    refetchInterval: (query) => (query.state.data?.run.canCancel === true ? 1_000 : false),
  });
};
