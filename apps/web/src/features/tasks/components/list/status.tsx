import type { StalledItemView } from "@usine/orchestrator/operator";
import { Match } from "effect";
import { ItemMark } from "~/components/item/mark";
import { StateMark } from "~/components/status-badge";
import { SIDE_CONTENT } from "~/features/tasks/lib/columns";
import { stallNamesLoop, stallSentence } from "~/lib/stall/strings";
import { agoLabel, timestampLabel } from "~/lib/strings";
import { runActivityAt, type TaskRow } from "~/lib/tasks/model";
import { cn } from "~/lib/utils";

/** Returns the tone of a stall's state mark, from the Run its reason references or from the reason. */
const stallTone = ({ reason }: StalledItemView): string =>
  Match.valueTags(reason, {
    AwaitingApproval: () => "Waiting",
    SuppressedForOperator: () => "needs-you",
    CycleBudgetUsedUp: () => "needs-you",
    RunFailed: () => "Failed",
    ClosedUnchanged: ({ run }) => run.state,
    LoopPaused: () => "paused",
    WaitingForStop: ({ run }) => run.state,
    QueuedForWorker: ({ run }) => run.state,
    WaitingForUpgrade: () => "Waiting",
    AwaitingPoll: () => "Pending",
  });

/**
 * Returns the Task's status mark state, text, and last activity time. For a stall, `at` is `null`
 * because the text has its own time, and the Loop name is prefixed if the stall text and the last
 * Run do not include it.
 */
const statusLine = (
  { last, status }: TaskRow,
  now: number,
): {
  /** The state mark's tone; `Done` shows the current item's GitHub state instead. */
  readonly state: string;
  readonly words: string;
  readonly at: string | null;
} => {
  const at = runActivityAt(last);
  const stallLine = (stall: StalledItemView) => ({
    state: stallTone(stall),
    words: `${last.loop !== stall.loop && !stallNamesLoop(stall) ? `${stall.loop} ` : ""}${stallSentence(stall, now)}`,
    at: null,
  });
  return Match.valueTags(status, {
    Running: ({ run }) => ({ state: "Running", words: `Running ${run.loop}`, at }),
    AwaitingApproval: () => ({ state: "Waiting", words: "Waiting for approval", at }),
    Queued: ({ run }) => ({ state: run.state, words: run.state, at }),
    Stalled: ({ stall }) => stallLine(stall),
    Idle: ({ stall }) => stallLine(stall),
    NeedsAttention: () => ({ state: "needs-you", words: "Needs attention", at }),
    Done: () => ({ state: "Done", words: "Done", at }),
    Ended: ({ run }) => ({ state: run.state, words: run.state, at }),
  });
};

type StatusProps = { readonly row: TaskRow; readonly now: number };

/** Renders the status, for example `Done · 28m ago`; if the text wraps, the mark stays on the first line. */
export const Status = ({ row, now }: StatusProps) => {
  const { state, words, at } = statusLine(row, now);
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
              <time dateTime={at} title={timestampLabel(at)} className="font-mono tabular-nums">
                {agoLabel(at, now)}
              </time>
            </span>
          </>
        )}
      </span>
    </span>
  );
};
