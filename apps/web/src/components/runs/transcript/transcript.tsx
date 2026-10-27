import type { TranscriptPageCursor } from "@usine/orchestrator/operator";
import { ChapterView } from "~/components/runs/transcript/chapter-view";
import { ReaderLine } from "~/components/runs/transcript/reader-line";
import { MessageScrollerItem } from "~/components/ui/message-scroller";
import type { ReaderDocument } from "~/lib/runs/transcript/document/model";

/** Earlier transcript page cursors per Attempt, with their loading state. */
export interface TranscriptHistory {
  readonly cursors: ReadonlyArray<TranscriptPageCursor>;
  readonly loading: boolean;
  readonly error: string | null;
  readonly load: (cursor: TranscriptPageCursor) => void;
}

type TranscriptProps = {
  readonly document: ReaderDocument;
  readonly runTask: string;
  readonly history: TranscriptHistory;
};

export const Transcript = ({ document, runTask, history }: TranscriptProps) => {
  if (document.chapters.length === 0)
    return (
      <MessageScrollerItem messageId="empty">
        <ReaderLine>
          <p className="text-xs text-muted-foreground">No attempt started</p>
        </ReaderLine>
      </MessageScrollerItem>
    );
  return document.chapters.map((chapter, index) => (
    <ChapterView
      key={chapter.key}
      chapter={chapter}
      first={index === 0}
      runTask={runTask}
      history={history}
    />
  ));
};
