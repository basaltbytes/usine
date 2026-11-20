import { boardTaskRuns } from "@usine/orchestrator/operator";
import { CiHandoffLine } from "~/components/runs/ci";
import { ItemMark } from "~/components/item/mark";
import { StateMark } from "~/components/status-badge";
import { SIDE_CONTENT } from "~/features/tasks/lib/columns";
import { agoLabel, timestampLabel } from "~/lib/strings";
import type { TaskRow } from "~/lib/tasks/model";
import { statusLine } from "~/lib/tasks/status";
import { cn } from "~/lib/utils";
import { TextTooltip } from "~/components/text-tooltip";

type StatusProps = { readonly row: TaskRow; readonly now: number };

/** Renders the status, for example `Done · 28m ago`; if the text wraps, the mark stays on the first line. */
export const Status = ({ row, now }: StatusProps) => {
  const { state, words, at } = statusLine(row, now);
  const displayed = "run" in row.status ? row.status.run : row.last;
  const source = [...boardTaskRuns(row.task)]
    .reverse()
    .find(
      ({ id, handoff }) =>
        handoff !== null && (handoff.fixRunId === displayed.id || id === displayed.id),
    );
  // A word wider than `--side`, such as the Loop `dependency_updates`, breaks inside the column:
  // `min-w-0` lets the text shrink below that word, and `wrap-break-word` breaks it only then. On a
  // phone, where the column is as wide as its longest word, text still wraps between words.
  return (
    <span className={cn("flex items-start gap-1.5 text-xs/5 font-medium", SIDE_CONTENT)}>
      {state === "Done" ? (
        <ItemMark item={row.task} linked={false} numbered={false} className="mt-0.75" />
      ) : (
        <StateMark state={state} className="mt-1.75 mr-0.5 ml-0.75" />
      )}
      <span className="min-w-0 wrap-break-word">
        {words}
        {at !== null && (
          <>
            {" "}
            <span className="font-normal whitespace-nowrap text-muted-foreground">
              ·{" "}
              <TextTooltip text={timestampLabel(at)}>
                <time dateTime={at} className="font-mono tabular-nums">
                  {agoLabel(at, now)}
                </time>
              </TextTooltip>
            </span>
          </>
        )}
        {source !== undefined && (
          <span className="block font-normal">
            <CiHandoffLine run={source} />
          </span>
        )}
      </span>
    </span>
  );
};
