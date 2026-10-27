import { Match, Option } from "effect";
import { Delegation } from "~/components/runs/transcript/delegation";
import { GitHubChangeLine } from "~/components/runs/transcript/github-change";
import { ToolBurst } from "~/components/runs/transcript/grouping/burst";
import { Gutter } from "~/components/runs/transcript/gutter";
import { Message } from "~/components/runs/transcript/message";
import { Outcome } from "~/components/runs/transcript/outcome";
import { ReaderLine } from "~/components/runs/transcript/reader-line";
import type { ChapterRow } from "~/lib/runs/transcript/document/model";
import { cn } from "~/lib/utils";

type RowProps = { readonly row: ChapterRow; readonly speaker: string | null };

export const Row = ({ row, speaker }: RowProps) =>
  Match.valueTags(row, {
    Message: (message) => <Message row={message} speaker={speaker} />,
    Note: (note) => (
      <ReaderLine gutter={<Gutter receivedAt={note.receivedAt} speaker={speaker} />}>
        <p
          data-transcript-id={note.key}
          className={cn(
            "text-xs leading-[1.4rem] wrap-anywhere",
            {
              plain: "text-muted-foreground",
              warning: "text-warning",
              failed: "text-destructive",
            }[note.tone],
          )}
        >
          {note.tone === "warning" && <span className="sr-only">Warning: </span>}
          {note.text}
        </p>
      </ReaderLine>
    ),
    Burst: (burst) => (
      <ReaderLine gutter={<Gutter speaker={speaker} />}>
        <ToolBurst burst={burst} />
      </ReaderLine>
    ),
    Delegation: (delegation) => <Delegation row={delegation} speaker={speaker} />,
    GitHubChange: (change) => (
      <ReaderLine>
        <GitHubChangeLine row={change} />
      </ReaderLine>
    ),
    BoardMove: ({ move }) => (
      <ReaderLine gutter={<Gutter receivedAt={move.at} />}>
        <p className="text-xs leading-[1.4rem] wrap-anywhere text-muted-foreground">
          You moved it from {move.fromLane} to {move.toLane} on the board
        </p>
      </ReaderLine>
    ),
    Ending: (ending) => (
      <ReaderLine
        gutter={
          <Gutter
            receivedAt={Option.getOrUndefined(ending.receivedAt)}
            speaker={speaker}
            tone={ending.end._tag === "Failed" ? "failed" : "plain"}
          />
        }
      >
        <div data-transcript-id={Option.isSome(ending.position) ? ending.key : undefined}>
          <Outcome end={ending.end} outOfMemory={ending.outOfMemory} />
        </div>
      </ReaderLine>
    ),
  });
