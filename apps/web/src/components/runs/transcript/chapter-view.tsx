import { transcriptAttemptLabel, transcriptHistoryLabel } from "~/lib/runs/strings";
import { Match } from "effect";
import { ErrorAlert } from "~/components/error-alert";
import { CurrentActivity } from "~/components/runs/transcript/activity";
import { AttemptMeta } from "~/components/runs/transcript/attempt-meta";
import { ReaderLine } from "~/components/runs/transcript/reader-line";
import { Row } from "~/components/runs/transcript/row";
import { type TranscriptHistory } from "~/components/runs/transcript/transcript";
import { Button } from "~/components/ui/button";
import { MessageScrollerItem } from "~/components/ui/message-scroller";
import type { Chapter, ChapterRow, Speaker } from "~/lib/runs/transcript/document/model";
import { cn } from "~/lib/utils";

const rowSpeaker = (row: ChapterRow): Speaker | null =>
  Match.valueTags(row, {
    Message: ({ speaker }) => speaker,
    Note: ({ speaker }) => speaker,
    Burst: ({ speaker }) => speaker,
    Delegation: ({ speaker }) => speaker,
    Ending: ({ speaker }) => speaker,
    GitHubChange: () => null,
    BoardMove: () => null,
  });

const rowGap = (row: ChapterRow, previous: ChapterRow | undefined): "tight" | "near" | "apart" => {
  if (row._tag === "Burst") return "tight";
  if (row._tag === "GitHubChange")
    return previous?._tag === "Burst" || previous?._tag === "GitHubChange" ? "tight" : "near";
  return row._tag === "Note" || row._tag === "BoardMove" ? "near" : "apart";
};

type ChapterViewProps = {
  readonly chapter: Chapter;
  readonly first: boolean;
  readonly runTask: string;
  readonly history: TranscriptHistory;
};

export const ChapterView = ({ chapter, first, runTask, history }: ChapterViewProps) => {
  const cursor = history.cursors.find(({ attemptId }) => attemptId === chapter.attemptId);
  let previous: Speaker | null = null;
  const rows = chapter.rows.map((row) => {
    const speaker = rowSpeaker(row);
    const changed =
      speaker !== null &&
      (previous === null ||
        previous.name !== speaker.name ||
        previous.sessionKey !== speaker.sessionKey);
    if (speaker !== null) previous = speaker;
    return { row, speaker: changed ? speaker.name : null };
  });
  return (
    <>
      <MessageScrollerItem messageId={chapter.key} className={first ? undefined : "mt-10"}>
        <ReaderLine className={first ? undefined : "border-t pt-8"}>
          <h2 className="text-md font-semibold">{transcriptAttemptLabel(chapter.attempt)}</h2>
          <AttemptMeta chapter={chapter} runTask={runTask} />
        </ReaderLine>
      </MessageScrollerItem>
      {cursor !== undefined && (
        <MessageScrollerItem messageId={`history:${chapter.attemptId}`} className="mt-4">
          <ReaderLine>
            <Button
              variant="outline"
              size="sm"
              disabled={history.loading}
              onClick={() => history.load(cursor)}
            >
              {history.loading
                ? transcriptHistoryLabel.loading
                : transcriptHistoryLabel.loadEarlier}
            </Button>
            {history.error !== null && <ErrorAlert className="mt-2" message={history.error} />}
          </ReaderLine>
        </MessageScrollerItem>
      )}
      {rows.length === 0 && cursor === undefined && !chapter.live && (
        <MessageScrollerItem messageId={`empty:${chapter.attemptId}`} className="mt-4">
          <ReaderLine>
            <p className="text-xs text-muted-foreground">{transcriptHistoryLabel.empty}</p>
          </ReaderLine>
        </MessageScrollerItem>
      )}
      {rows.map(({ row, speaker }, index) => {
        const gap = rowGap(row, rows[index - 1]?.row);
        return (
          <MessageScrollerItem
            key={row.key}
            messageId={row.key}
            className={cn(
              gap === "tight" && "mt-0.5",
              gap === "near" && "mt-2",
              gap === "apart" && "mt-4",
            )}
          >
            <Row row={row} speaker={speaker} />
          </MessageScrollerItem>
        );
      })}
      {chapter.live && (
        <MessageScrollerItem
          messageId={`activity:${chapter.attemptId}`}
          className="mt-4 [content-visibility:visible]"
        >
          <ReaderLine>
            <CurrentActivity chapter={chapter} />
          </ReaderLine>
        </MessageScrollerItem>
      )}
    </>
  );
};
