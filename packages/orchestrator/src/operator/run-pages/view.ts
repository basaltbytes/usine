import { SettledItemState } from "@usine/config/board";
import { AgentSessionId, TokenCount } from "@usine/core/agent/session";
import { AttemptId, AttemptNumber } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import { TranscriptSequence } from "@usine/engine/transcript";
import { type Brand, Schema } from "effect";
import { MachineView } from "../machines.ts";
import { fillText, jsonBytes, PAGE_BYTES, textStart } from "../page.ts";
import { RunDurationView, RunSummaryView, UnconfirmedStopView } from "../run.ts";
import { PoolUsageView } from "../usage.ts";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** The most UTF-16 code units of a text that a run brief shows. */
const EXCERPT_LENGTH = 1_500;

/** The beginning of a text and the length of the whole text, in UTF-16 code units. */
export class TextExcerptView extends Schema.Class<
  TextExcerptView,
  Brand.Brand<"@usine/orchestrator/operator/run-pages/TextExcerptView">
>("@usine/orchestrator/TextExcerptView")({
  /** The first 1,500 code units of the text, or the whole text if it is shorter. */
  text: Schema.String,
  /** The length of the whole text. */
  length: Count,
}) {}

/** Returns the excerpt of `text` that a run brief shows. */
export const textExcerpt = (text: string) =>
  TextExcerptView.make({ text: textStart(text, EXCERPT_LENGTH), length: text.length });

/** The final report that a failed Attempt kept, as an excerpt. */
export class AttemptReportView extends Schema.Class<
  AttemptReportView,
  Brand.Brand<"@usine/orchestrator/operator/run-pages/AttemptReportView">
>("@usine/orchestrator/AttemptReportView")({
  /** The Attempt that kept the report. */
  attemptId: AttemptId,
  /** The one-based Attempt number within the Run. */
  number: AttemptNumber,
  /** The beginning of the report. */
  report: TextExcerptView,
}) {}

/**
 * A Run without its event payload and transcript, and with the beginnings of its texts: what an
 * agent reads to see why a Run stopped and what to read next.
 */
export class RunBriefView extends Schema.TaggedClass<
  RunBriefView,
  Brand.Brand<"@usine/orchestrator/operator/run-pages/RunBriefView">
>("@usine/orchestrator/RunBriefView")("RunBrief", {
  /** The Run with its state, waits, actions, and Attempts with their outcomes and failures. */
  run: RunSummaryView,
  /** The beginning of the Run's effective task prompt. */
  task: TextExcerptView,
  /** The beginning of the successful result message, or null without one. */
  resultMessage: Schema.NullOr(TextExcerptView),
  /** The final report of the newest Attempt that kept one, or null if none did. */
  report: Schema.NullOr(AttemptReportView),
  /** The deduplication key of the event that opened the Run. */
  eventDedupKey: Schema.String,
  /** Whether the loaded Agent differs from the saved definition; false if no longer loaded. */
  agentDefinitionChanged: Schema.Boolean,
  /** The Worker of the newest Attempt, or null before the first Attempt. */
  worker: Schema.NullOr(WorkerName),
  /** The state of the Run's Item if it is closed, merged, or gone, else null. */
  settledItemState: Schema.NullOr(SettledItemState),
  /** Summed Attempt wall time and the start of the Attempt still running. */
  duration: RunDurationView,
  /** The tokens the Run's sessions reported, and their total per billing pool. */
  usage: Schema.Struct({ tokens: TokenCount, pools: Schema.Array(PoolUsageView) }),
  /** The unconfirmed stop that keeps the open Run from starting an Attempt, or null. */
  unconfirmedStop: Schema.NullOr(UnconfirmedStopView),
  /** The machine of the Run's next or running Attempt, or null. */
  machine: Schema.NullOr(MachineView),
}) {}

/**
 * A text of a Run: its effective task prompt, its result message, an Attempt's final report, or the
 * JSON text of the event that opened it.
 */
export const RunTextPart = Schema.Literals(["task", "result", "report", "event"]);
/** A text of a run: its task prompt, result message, an attempt's report, or its event JSON. */
export type RunTextPart = typeof RunTextPart.Type;

/** A page of one text of a Run. */
export class RunTextPageView extends Schema.Class<
  RunTextPageView,
  Brand.Brand<"@usine/orchestrator/operator/run-pages/RunTextPageView">
>("@usine/orchestrator/RunTextPageView")({
  /** The Run that the text belongs to. */
  runId: RunId,
  /** Which text of the Run this is. */
  part: RunTextPart,
  /** The Attempt whose report this is; null for the other texts. */
  attemptId: Schema.NullOr(AttemptId),
  /** The text from `offset`, as much as fits the page. */
  text: Schema.String,
  /** The position of `text` in the whole text, in UTF-16 code units. */
  offset: Count,
  /** The length of the whole text; 0 if the Run has no such text. */
  length: Count,
  /** The position where the next page starts, or null after the end of the text. */
  nextOffset: Schema.NullOr(Count),
}) {}

/** Returns the page of `text` from `offset` that fits `PAGE_BYTES` of JSON. */
export const runTextPage = (
  runId: RunId,
  part: RunTextPart,
  attemptId: AttemptId | null,
  text: string,
  offset: number,
): RunTextPageView => {
  const view = (slice: string, start: number) => {
    const end = start + slice.length;
    return RunTextPageView.make({
      runId,
      part,
      attemptId,
      text: slice,
      offset: start,
      length: text.length,
      nextOffset: end < text.length ? end : null,
    });
  };
  // `fillText` measures the view without text, whose `nextOffset` can have fewer digits.
  const bytes = PAGE_BYTES - String(text.length).length;
  const [page] = fillText([{ text, view }], offset, 0, false, bytes).views;
  return page ?? view("", Math.min(offset, text.length));
};

/**
 * One transcript entry of an Attempt, with its payload as JSON text. `kind` is the session
 * event's kind, such as `ToolFinished` or `TextOutput`, for a session event, and the message kind,
 * such as `Started`, `Final`, or `Failed`, for the other entries.
 */
export class TranscriptTextView extends Schema.Class<
  TranscriptTextView,
  Brand.Brand<"@usine/orchestrator/operator/run-pages/TranscriptTextView">
>("@usine/orchestrator/TranscriptTextView")({
  /** The durable transcript sequence. */
  sequence: TranscriptSequence,
  /** The time the orchestrator stored the entry, as an ISO 8601 timestamp. */
  receivedAt: Schema.String,
  /** Whether the message came from the Attempt or the operator. */
  direction: AttemptChannel.Direction,
  /** The kind of session event or message. */
  kind: Schema.String,
  /** The session that produced a session event; null for the other entries. */
  session: Schema.NullOr(AgentSessionId),
  /** The entry's JSON text from `offset`, without its kind and session. */
  text: Schema.String,
  /** The position of `text` in the entry's JSON text, in UTF-16 code units. */
  offset: Count,
  /** The length of the entry's JSON text. */
  length: Count,
}) {}

/** Where a transcript page starts: before a sequence of an Attempt, and into an entry's text. */
export class RunTranscriptCursor extends Schema.Class<
  RunTranscriptCursor,
  Brand.Brand<"@usine/orchestrator/operator/run-pages/RunTranscriptCursor">
>("@usine/orchestrator/RunTranscriptCursor")({
  /** The Attempt whose transcript to read. */
  attempt: AttemptId,
  /** The page starts at the newest entry with a smaller sequence. */
  before: TranscriptSequence,
  /** The position in that entry's text to start from. */
  offset: Count,
}) {}

/** A page of an Attempt's transcript, newest entry first. */
export class RunTranscriptPageView extends Schema.Class<
  RunTranscriptPageView,
  Brand.Brand<"@usine/orchestrator/operator/run-pages/RunTranscriptPageView">
>("@usine/orchestrator/RunTranscriptPageView")({
  /** The Run that the transcript belongs to. */
  runId: RunId,
  /** The Attempt whose transcript this is, or null for a Run without Attempts. */
  attemptId: Schema.NullOr(AttemptId),
  /** The one-based number of that Attempt, or null for a Run without Attempts. */
  attemptNumber: Schema.NullOr(AttemptNumber),
  /** The entries of this page, newest first. An entry too long for the page is cut. */
  entries: Schema.Array(TranscriptTextView),
  /** Where the page of older entries starts, or null after the Attempt's first entry. */
  next: Schema.NullOr(RunTranscriptCursor),
}) {}

/** A transcript entry with its kind, session, and JSON text, before paging. */
export interface TranscriptText {
  readonly sequence: TranscriptSequence;
  readonly receivedAt: string;
  readonly direction: AttemptChannel.Direction;
  readonly kind: string;
  readonly session: AgentSessionId | null;
  readonly text: string;
}

/** The transcript page envelope's JSON bytes, with a cursor as wide as any the page can have. */
export const transcriptPageBytes = (runId: RunId, attemptId: AttemptId, number: AttemptNumber) =>
  jsonBytes(
    RunTranscriptPageView.make({
      runId,
      attemptId,
      attemptNumber: number,
      entries: [],
      next: RunTranscriptCursor.make({
        attempt: attemptId,
        before: TranscriptSequence.make(Number.MAX_SAFE_INTEGER),
        offset: Number.MAX_SAFE_INTEGER,
      }),
    }),
  );

/** Returns the page entries of `texts`, newest first, as `fillText` takes them. */
export const transcriptEntries = (texts: ReadonlyArray<TranscriptText>) =>
  texts.map((entry) => ({
    text: entry.text,
    view: (part: string, offset: number) =>
      TranscriptTextView.make({ ...entry, text: part, offset, length: entry.text.length }),
  }));
