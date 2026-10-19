import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RunId } from "@usine/core/run";
import {
  ColdTranscriptRequest,
  EarlierTranscriptRequest,
  RunDetailView,
  TailTranscriptRequest,
  type TranscriptPageCursor,
} from "@usine/orchestrator/operator";
import { api } from "../api.ts";
import {
  mergeEarlierTranscript,
  mergeTranscript,
  RUN_DETAIL_CACHE_STRUCTURAL_SHARING,
} from "./cache.ts";
import { fetchRunDetail } from "./fetch.ts";

/**
 * A Run's detail, shared by the drawer and the Run page. The first read takes the newest
 * transcript window; later reads append the tail, every second while the Run can be canceled.
 */
export const useRunDetail = (runId: RunId, enabled: boolean) => {
  const queryClient = useQueryClient();
  return useQuery<RunDetailView>({
    queryKey: ["run", runId],
    queryFn: async () => {
      const key = ["run", runId] as const;
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
    structuralSharing: RUN_DETAIL_CACHE_STRUCTURAL_SHARING,
    enabled,
    refetchInterval: (query) => (query.state.data?.run.canCancel === true ? 1_000 : false),
  });
};

/** Loads one Attempt's earlier transcript page into the cached Run detail. */
export const useEarlierTranscript = (runId: RunId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (cursor: TranscriptPageCursor) =>
      api((client) =>
        client.detail({ params: { runId }, query: new EarlierTranscriptRequest(cursor) }),
      ),
    onSuccess: (page, cursor) => {
      queryClient.setQueryData<RunDetailView>(["run", runId], (previous) =>
        previous === undefined ? previous : mergeEarlierTranscript(previous, page, cursor),
      );
    },
  });
};
