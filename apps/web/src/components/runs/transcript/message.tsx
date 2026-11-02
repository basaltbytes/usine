import { Markdown } from "~/components/markdown";
import { Gutter } from "~/components/runs/transcript/gutter";
import { ReaderLine } from "~/components/runs/transcript/reader-line";
import type { MessageRow } from "~/lib/runs/transcript/document/model";
import { messageDeliveryLabel, queuedMessageLabel } from "~/lib/runs/strings";

type MessageProps = {
  readonly row: MessageRow;
  readonly speaker: string | null;
};

export const Message = ({ row, speaker }: MessageProps) => (
  <ReaderLine
    gutter={
      <Gutter
        receivedAt={row.receivedAt}
        speaker={speaker}
        tone={row.blocked || row.undelivered ? "failed" : "plain"}
      />
    }
  >
    <div data-transcript-id={row.key} className="min-w-0">
      {row.blocked && <span className="sr-only">Blocked: </span>}
      {row.format === "markdown" ? (
        <Markdown className="text-md wrap-anywhere">{row.text}</Markdown>
      ) : (
        <p className="text-md whitespace-pre-wrap wrap-anywhere">{row.text}</p>
      )}
      {row.undelivered && row.delivery === null && (
        <p className="text-xs text-destructive">Not delivered</p>
      )}
      {row.delivery !== null && (
        <p
          className={row.undelivered ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
        >
          {messageDeliveryLabel(row.delivery)}
        </p>
      )}
      {row.queued !== null && (
        <p className="text-xs text-muted-foreground">{queuedMessageLabel(row.queued)}</p>
      )}
    </div>
  </ReaderLine>
);
