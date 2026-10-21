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

// The columns follow the table's own width, since the sidebar beside a mid-size window leaves
// less room than a phone held sideways. Elapsed time always shows. Tokens and Estimated cost need
// 56rem and Runs and Pull request 64rem.
const WIDE_COLUMN = "hidden @5xl:table-cell";
const USAGE_COLUMN = "hidden @4xl:table-cell";

// The title cell is `w-full max-w-0`: it takes the width the other columns leave, and they keep
// their narrowest width. Status and Runs, the columns that can wrap or truncate, take their own
// width up to `--side` and wrap past it, or truncate for Runs, so a short status takes only its
// words and they give way before the title does. `--side` is an equal share, between 7rem and
// 13rem, of the table less 26rem for the title, the width of a long issue title, and less
// `--rest`: the figure columns showing, which their headers set, and the side columns' padding.
// On a phone Status wraps to its longest word instead, so the table never scrolls sideways.
const SIDE_SHARE = [
  "@md:[--side:clamp(7rem,calc((100cqw-26rem-var(--rest))/var(--sides)),13rem)]",
  "[--rest:7rem] [--sides:1] @4xl:[--rest:16.5rem] @5xl:[--rest:23rem] @5xl:[--sides:2]",
].join(" ");
const SIDE_COLUMN = "py-3 align-top whitespace-normal";
const SIDE_CONTENT = "@md:w-max @md:max-w-(--side)";
const TOTAL_COLUMN = "py-3 text-right align-top font-mono text-xs/5 whitespace-nowrap tabular-nums";

const usageTrigger =
  "relative z-10 rounded-sm underline-offset-4 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/70 focus-visible:outline-solid";

/** The tone of a stall's state mark: the state of the Run its reason names, or what holds it. */
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
 * A Task's status: the state that gives its mark's tone, its words, and when the last Run was last
 * at work. A stall's words say their own time, so `at` is null for them, and the stall's Loop goes
 * first when neither the fragment nor the last Run names it.
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

/** The status's mark and words on the row's 20px line, then ` · ` and the time, such as
 * `Done · 28m ago`; the mark stays on the first line when the words wrap. */
const Status = ({ row, now }: { readonly row: TaskRow; readonly now: number }) => {
  const { state, words, at } = statusLine(row, now);
  // A word wider than `--side`, such as the Loop `dependency_updates`, breaks inside the column:
  // `min-w-0` lets the words shrink below that word, and `wrap-break-word` breaks it only then, so
  // on a phone, where the column is as wide as its longest word, the words still wrap between words.
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

/** The Loops in the order they first ran, each after the mark of its last Run's state, then the
 * Run count. */
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

/** The `*` after a figure lower than the real one, hung past the figure's end so the figures of a
 * column stay aligned. Its parent is positioned. */
const LowerBoundMark = () => <span className="absolute left-full text-muted-foreground">*</span>;

/** A Task's Attempt time, counting on while an Attempt runs; nothing before any Attempt began. */
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

/** `children` opening, on hover or focus, the Task's tokens per billing pool, after `note` when it
 * is not null. */
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

/** A Task's priced dollars, marked `*` while part of its usage has no price yet; nothing when no
 * usage has a price. */
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

/** The pull request's number as a link, then whether it is open or merged. */
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

/** The totals of every listed Task, such as `9 runs, 6 h 12 min elapsed, 4.8M tokens, $14.20
 * estimated`, each lower bound marked `*` with the reason in its title. */
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
 * The Tasks of a Project that usine ran at least once, as rows: those in flight first, then the
 * rest, as `taskRows` orders them. `stalled` is the desk's list of stalled Items, whose reason a
 * stalled Task's status shows.
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
