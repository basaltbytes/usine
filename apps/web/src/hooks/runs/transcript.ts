import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RunId } from "@usine/core/run";
import {
  EarlierTranscriptRequest,
  RunDetailView,
  type TranscriptPageCursor,
} from "@usine/orchestrator/operator";
import { api } from "~/lib/api";
import { mergeEarlierTranscript } from "~/lib/runs/transcript/cache";
import { runDetailKey } from "~/lib/runs/queries";

/** Fetches one Attempt's earlier transcript page and merges it into the cached Run detail. */
export const useEarlierTranscript = (runId: RunId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (cursor: TranscriptPageCursor) =>
      api((client) =>
        client.detail({ params: { runId }, query: new EarlierTranscriptRequest(cursor) }),
      ),
    onSuccess: (page, cursor) => {
      queryClient.setQueryData<RunDetailView>(runDetailKey(runId), (previous) =>
        previous === undefined ? previous : mergeEarlierTranscript(previous, page, cursor),
      );
    },
  });
};
