import { changes } from "~/lib/query-changes";
import { queryOptions, type QueryClient } from "@tanstack/react-query";
import type { RunId } from "@usine/core/run";
import {
  ColdTranscriptRequest,
  RunDetailView,
  TailTranscriptRequest,
  type TranscriptRequest,
} from "@usine/orchestrator/operator";
import { Effect, Schema } from "effect";
import { api, type Client } from "~/lib/api";
import { mergeTranscript, RUN_DETAIL_CACHE_STRUCTURAL_SHARING } from "~/lib/runs/transcript/cache";
import { fetchRunDetail } from "~/lib/runs/transcript/fetch";

/**
 * Reads a Run's detail with `X-Usine-View: full`; without it, the server returns the Run's brief.
 * Use it inside `api` with the `full` view.
 */
export const readRunDetail = (client: Client, runId: RunId, query: TranscriptRequest) =>
  client
    .detail({ params: { runId }, query })
    .pipe(
      Effect.filterOrElse(Schema.is(RunDetailView), () =>
        Effect.die("The server returned a run brief instead of the run detail."),
      ),
    );

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
          ? ColdTranscriptRequest.make()
          : TailTranscriptRequest.make({ after: cursor }),
        (query) => api((client) => readRunDetail(client, runId, query), "full"),
      );
      const current = queryClient.getQueryData<RunDetailView>(key);
      if (cursor === undefined || current === undefined) return next;
      return RunDetailView.make({
        ...next,
        transcript: mergeTranscript(current.transcript, next.transcript),
        earlierTranscript: current.earlierTranscript,
      });
    },
    staleTime: 30_000,
    structuralSharing: RUN_DETAIL_CACHE_STRUCTURAL_SHARING,
    meta: {
      refreshLabel: "Run",
      changes: changes.any(changes.run(runId), changes.kind("configuration")),
    },
  });
};
