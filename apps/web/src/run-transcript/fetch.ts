import {
  type ColdTranscriptRequest,
  RunDetailView,
  TailTranscriptRequest,
} from "@usine/orchestrator/operator";
import { mergeTranscript } from "./cache.ts";

type DetailRequest = ColdTranscriptRequest | TailTranscriptRequest;

/**
 * Reads a Run update through the operator client. Terminal tails are drained to
 * an empty page so stopping live polling cannot strand newer transcript events.
 * Cold history retains its earlier-page cursors; running tails remain one poll.
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
