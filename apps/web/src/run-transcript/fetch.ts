import {
  type ColdTranscriptRequest,
  RunDetailView,
  TailTranscriptRequest,
} from "@usine/orchestrator/operator";
import { mergeTranscript } from "./cache.ts";

type DetailRequest = ColdTranscriptRequest | TailTranscriptRequest;

/**
 * Fetches a Run detail page. For a tail request on a Run that can no longer be canceled, reads pages
 * until one is empty, so no events are missed after polling stops.
 */
export const fetchRunDetail = async (
  request: DetailRequest,
  read: (request: DetailRequest) => Promise<RunDetailView>,
): Promise<RunDetailView> => {
  let page = await read(request);
  if (request._tag === "ColdTranscriptRequest") return page;
  let transcript = page.transcript;
  while (!page.run.canCancel) {
    const last = page.transcript.at(-1);
    if (last === undefined) break;
    page = await read(new TailTranscriptRequest({ after: last.sequence }));
    transcript = mergeTranscript(transcript, page.transcript);
  }
  return new RunDetailView({ ...page, transcript });
};
