import { Link } from "@tanstack/react-router";
import type { RepositoryName } from "@usine/core/repository";
import type {
  BoardPullRequestView,
  BoardTaskView,
  ProjectView,
  StalledItemView,
  TaskUsageView,
} from "@usine/orchestrator/operator";
import { Match } from "effect";
import { Fragment, type ReactNode } from "react";
import { Page, PageHeading } from "@/components/page";
import { StateMark } from "@/components/status-badge";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";
import { EmptyLine, ItemTitle } from "../desk/section.tsx";
import {
  agoLabel,
  durationLabel,
  timestampLabel,
  tokensLabel,
  usdLabel,
} from "../operator-copy.ts";
import { projectParams } from "../overview.ts";
import { PoolBreakdown } from "../run-page/usage.tsx";
import { stallNamesLoop, stallSentence } from "../stall/copy.ts";
import {
  costUnpriced,
  itemStateLabel,
  runActivityAt,
  type TaskRow,
  type TaskTotals,
  taskCounts,
  taskDuration,
  taskLoops,
  taskNumber,
  taskOrigin,
  taskRows,
  taskTotals,
  totalsFigures,
  unpricedNote,
  untimedNote,
} from "./model.ts";
import { linkedRow, rowLink } from "./section.tsx";

const pullRequestLink =
  "relative z-10 rounded-sm font-mono text-xs text-primary underline-offset-4 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/70 focus-visible:outline-solid";

// Column visibility uses container queries on the table width, because the sidebar can leave less
// room than the viewport suggests. Elapsed time is always shown; Tokens and Estimated cost need
// 56rem, Runs and Pull request 64rem.
const WIDE_COLUMN = "hidden @5xl:table-cell";
const USAGE_COLUMN = "hidden @4xl:table-cell";

// The title cell is `w-full max-w-0`, so it takes the remaining width and the other columns keep
// their minimum width. Status and Runs are at most `--side` wide; beyond it, Status wraps and Runs
// truncates. `--side` is an equal share, from 7rem to 13rem, of the table width minus 26rem for the
// title and minus `--rest`, the width of the visible figure columns and the side padding. On a
// phone, Status wraps at its longest word, so the table does not scroll horizontally.
const SIDE_SHARE = [
  "@md:[--side:clamp(7rem,calc((100cqw-26rem-var(--rest))/var(--sides)),13rem)]",
  "[--rest:7rem] [--sides:1] @4xl:[--rest:16.5rem] @5xl:[--rest:23rem] @5xl:[--sides:2]",
].join(" ");
const SIDE_COLUMN = "py-3 align-top whitespace-normal";
const SIDE_CONTENT = "@md:w-max @md:max-w-(--side)";
const TOTAL_COLUMN = "py-3 text-right align-top font-mono text-xs/5 whitespace-nowrap tabular-nums";

const usageTrigger =
  "relative z-10 rounded-sm underline-offset-4 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/70 focus-visible:outline-solid";

/** Returns the tone of a stall's state mark, from the Run its reason references or from the reason. */
const stallTone = ({ reason }: StalledItemView): string =>
  Match.valueTags(reason, {
    AwaitingApproval: () => "Waiting",
    HeldForOperator: () => "needs-you",
    CycleBudgetUsedUp: () => "needs-you",
    RunFailed: () => "Failed",
    ClosedUnchanged: ({ run }) => run.state,
    LoopPaused: () => "paused",
    QueuedForWorker: ({ run }) => run.state,
    AwaitingPoll: () => "Pending",
  });

/**
 * Returns the Task's status mark state, text, and last activity time. For a stall, `at` is `null`
 * because the text has its own time, and the Loop name is prefixed if the stall text and the last
 * Run do not include it.
 */
const statusLine = (
  { task, last, status }: TaskRow,
  now: number,
): { readonly state: string; readonly words: string; readonly at: string | null } => {
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
    Done: () => ({ state: itemStateLabel(task.state), words: "Done", at }),
    Ended: ({ run }) => ({ state: run.state, words: run.state, at }),
  });
};

/** Renders the status, for example `Done · 28m ago`; if the text wraps, the mark stays on the first line. */
const Status = ({ row, now }: { readonly row: TaskRow; readonly now: number }) => {
  const { state, words, at } = statusLine(row, now);
  // A word wider than `--side`, such as the Loop `dependency_updates`, breaks inside the column:
  // `min-w-0` lets the text shrink below that word, and `wrap-break-word` breaks it only then. On a
  // phone, where the column is as wide as its longest word, text still wraps between words.
  return (
    <span className={cn("flex items-start gap-1.5 text-xs/5 font-medium", SIDE_CONTENT)}>
      <StateMark state={state} className="mt-1.75" />
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

/** Renders each Loop in first-run order with its last Run's state mark, then the Run count. */
const Runs = ({ task }: { readonly task: BoardTaskView }) => {
  const loops = taskLoops(task);
  return (
    <span className={cn("flex items-baseline gap-2", SIDE_CONTENT)}>
      <span className="truncate" title={loops.map(({ loop }) => loop).join(" · ")}>
        {loops.map(({ loop, state }, index) => (
          <Fragment key={loop}>
            {index > 0 && <span className="text-muted-foreground"> · </span>}
            <StateMark state={state} className="mr-1.5 align-middle" />
            {loop}
            <span className="sr-only"> {state}</span>
          </Fragment>
        ))}
      </span>
      <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
        {task.runs.length}
      </span>
    </span>
  );
};

/** Renders the `*` after a lower-bound figure, past the figure's end so the column stays aligned;
 * the parent must be positioned. */
const LowerBoundMark = () => <span className="absolute left-full text-muted-foreground">*</span>;

/** Renders the total Attempt time, which keeps counting while an Attempt runs, or nothing before any Attempt starts. */
const TaskTime = ({ task, now }: { readonly task: BoardTaskView; readonly now: number }) => {
  const { usage } = task;
  if (task.runs.every(({ attempts }) => attempts.length === 0)) return null;
  const untimed = usage.unmeasured > 0;
  return (
    <span className="relative" title={untimed ? untimedNote : "Total attempt time"}>
      {durationLabel(taskDuration(usage, now))}
      {untimed && <LowerBoundMark />}
    </span>
  );
};

/** Shows the Task's tokens per billing pool when `children` is hovered or focused, after `note` if set. */
const PoolHover = ({
  usage,
  label,
  note,
  children,
}: {
  readonly usage: TaskUsageView;
  readonly label: string;
  readonly note: string | null;
  readonly children: ReactNode;
}) => (
  <HoverCard>
    <HoverCardTrigger
      delay={200}
      aria-label={label}
      render={<button type="button" className={usageTrigger} />}
    >
      {children}
    </HoverCardTrigger>
    <HoverCardContent
      align="end"
      className="w-[26rem] max-w-[calc(100vw-2rem)] p-3 font-sans text-xs shadow-raised"
    >
      {note !== null && <p className="pb-2 text-muted-foreground">{note}.</p>}
      <PoolBreakdown pools={usage.pools} />
    </HoverCardContent>
  </HoverCard>
);

/** Renders the Task's cost in dollars, marked `*` if some usage is not priced yet, or nothing if no
 * usage is priced. */
const TaskCost = ({ usage }: { readonly usage: TaskUsageView }) => {
  if (usage.cost === null) return null;
  const unpriced = costUnpriced(usage);
  const usd = usdLabel(usage.cost.usd);
  return (
    <PoolHover
      usage={usage}
      label={`Estimated cost: ${unpriced ? "at least " : ""}${usd}. Show it per pool`}
      note={unpriced ? unpricedNote : null}
    >
      {usd}
      {unpriced && <LowerBoundMark />}
    </PoolHover>
  );
};

const PullRequest = ({ pullRequest }: { readonly pullRequest: BoardPullRequestView }) => (
  <span className="inline-flex items-baseline gap-1.5">
    <a href={pullRequest.url} target="_blank" rel="noreferrer" className={pullRequestLink}>
      #{pullRequest.number}
    </a>
    <span className="text-xs text-muted-foreground">
      {pullRequest.state === "pr-merged" ? "merged" : "open"}
    </span>
  </span>
);

const TaskListRow = ({
  row,
  repository,
  now,
}: {
  readonly row: TaskRow;
  readonly repository: RepositoryName;
  readonly now: number;
}) => (
  <TableRow className={linkedRow}>
    <TableCell className="w-full max-w-0 py-3 align-top">
      <Link
        data-row-link
        to="/projects/$owner/$name/tasks/$number"
        params={{ ...projectParams(repository), number: taskNumber(row.task) }}
        className={cn("block min-w-0", rowLink)}
      >
        <ItemTitle item={taskOrigin(row.task)} />
      </Link>
    </TableCell>
    <TableCell className={SIDE_COLUMN}>
      <Status row={row} now={now} />
    </TableCell>
    <TableCell className={cn("py-3 align-top", WIDE_COLUMN)}>
      <Runs task={row.task} />
    </TableCell>
    <TableCell className={cn("py-3 text-right align-top", WIDE_COLUMN)}>
      {row.task.pullRequest !== null && <PullRequest pullRequest={row.task.pullRequest} />}
    </TableCell>
    <TableCell className={TOTAL_COLUMN}>
      <TaskTime task={row.task} now={now} />
    </TableCell>
    <TableCell className={cn(TOTAL_COLUMN, USAGE_COLUMN)}>
      {row.task.usage.pools.length > 0 && (
        <PoolHover
          usage={row.task.usage}
          label={`Tokens: ${tokensLabel(row.task.usage.tokens)}. Show them per pool`}
          note={null}
        >
          {tokensLabel(row.task.usage.tokens)}
        </PoolHover>
      )}
    </TableCell>
    <TableCell className={cn(TOTAL_COLUMN, USAGE_COLUMN)}>
      <TaskCost usage={row.task.usage} />
    </TableCell>
  </TableRow>
);

/** Renders the totals of all listed Tasks, for example `9 runs, 6 h 12 min elapsed, 4.8M tokens,
 * $14.20 estimated`; each lower bound is marked `*` with the reason in its title. */
const TotalsLine = ({ totals }: { readonly totals: TaskTotals }) => (
  <p className="-mt-2 text-sm text-muted-foreground tabular-nums">
    {totalsFigures(totals).map(({ figure, words, lowerBound }, index) => (
      <Fragment key={words}>
        {index > 0 && ", "}
        {lowerBound === null ? figure : <span title={lowerBound}>{`${figure}*`}</span>} {words}
      </Fragment>
    ))}
  </p>
);

/**
 * Renders the Project's Tasks that usine ran at least once, in `taskRows` order. `stalled` is the
 * desk's list of stalled Items, used for the status of stalled Tasks.
 */
export const TaskList = ({
  project,
  stalled,
}: {
  readonly project: ProjectView;
  readonly stalled: ReadonlyArray<StalledItemView>;
}) => {
  const now = useNow(30_000);
  const rows = taskRows(project.board.lanes, stalled);
  return (
    <Page width="full">
      <PageHeading title="Tasks" counts={taskCounts(rows)} />
      {rows.length === 0 ? (
        <EmptyLine>No runs yet</EmptyLine>
      ) : (
        <>
          <TotalsLine totals={taskTotals(rows, now)} />
          <div className="@container -mx-2">
            <Table aria-label={`${project.repository} tasks`} className={SIDE_SHARE}>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Task</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className={WIDE_COLUMN}>Runs</TableHead>
                  <TableHead className={cn("text-right", WIDE_COLUMN)}>Pull request</TableHead>
                  <TableHead className="text-right">Elapsed time</TableHead>
                  <TableHead className={cn("text-right", USAGE_COLUMN)}>Tokens</TableHead>
                  <TableHead className={cn("text-right", USAGE_COLUMN)}>Estimated cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TaskListRow
                    key={row.task.itemKey}
                    row={row}
                    repository={project.repository}
                    now={now}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </Page>
  );
};
