import { Link } from "@tanstack/react-router";
import type { RepositoryName } from "@usine/core/repository";
import type {
  BoardPullRequestView,
  BoardTaskView,
  ProjectView,
  RunView,
  StalledItemView,
} from "@usine/orchestrator/operator";
import { Match } from "effect";
import { Fragment } from "react";
import { Page, PageHeading } from "@/components/page";
import { StateMark, StatusBadge } from "@/components/status-badge";
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
import { agoLabel, timestampLabel } from "../operator-copy.ts";
import { projectParams } from "../overview.ts";
import { stallNamesLoop, stallSentence } from "../stall/copy.ts";
import {
  itemStateLabel,
  runActivityAt,
  type TaskRow,
  taskCounts,
  taskLoops,
  taskNumber,
  taskOrigin,
  taskRows,
} from "./model.ts";
import { linkedRow, rowLink } from "./section.tsx";

const pullRequestLink =
  "relative z-10 rounded-sm font-mono text-xs text-primary underline-offset-4 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/70 focus-visible:outline-solid";

// The columns follow the table's own width, since the sidebar beside a mid-size window leaves
// less room than a phone held sideways. Runs and Pull request need 56rem, so they drop on phones
// and beside the sidebar on mid-size windows. Status and Last run keep a minimum width that grows
// with the table, from 28rem, and wrap past it; from 36rem Last run stays on one line. On a
// phone both wrap, so the table never scrolls sideways.
const WIDE_COLUMN = "hidden @4xl:table-cell";
const STATUS_COLUMN = "whitespace-normal @md:min-w-40 @xl:min-w-52";
const LAST_RUN_COLUMN = "whitespace-normal @md:min-w-28 @xl:whitespace-nowrap";

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

/** A Task's status: the state that gives its mark's tone, and its words. A stall's Loop goes
 * first when neither the fragment nor the last Run names it. */
const statusLine = (
  { task, last, status }: TaskRow,
  now: number,
): { readonly state: string; readonly words: string } =>
  Match.valueTags(status, {
    Running: ({ run }) => ({ state: "Running", words: `Running ${run.loop}` }),
    AwaitingApproval: () => ({ state: "Waiting", words: "Waiting for approval" }),
    Queued: ({ run }) => ({ state: run.state, words: run.state }),
    Stalled: ({ stall }) => ({
      state: stallTone(stall),
      words: `${last.loop !== stall.loop && !stallNamesLoop(stall) ? `${stall.loop} ` : ""}${stallSentence(stall, now)}`,
    }),
    NeedsAttention: () => ({ state: "needs-you", words: "Needs attention" }),
    Done: () => ({ state: itemStateLabel(task.state), words: "Done" }),
    Ended: ({ run }) => ({ state: run.state, words: run.state }),
  });

/** The status's mark and words on the row's 20px line; the mark stays on the first line when
 * the words wrap. */
const Status = ({ row, now }: { readonly row: TaskRow; readonly now: number }) => {
  const { state, words } = statusLine(row, now);
  return (
    <span className="flex items-start gap-1.5 text-xs/5 font-medium">
      <StateMark state={state} className="mt-1.75" />
      {words}
    </span>
  );
};

/** The Loops in the order they first ran, each after the mark of its last Run's state, then the
 * Run count. */
const Runs = ({ task }: { readonly task: BoardTaskView }) => {
  const loops = taskLoops(task);
  return (
    <span className="flex min-w-0 items-baseline gap-2">
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

/** The last Run's Loop, its state, and when it was last at work, such as `12m ago`. */
const LastRun = ({ run, now }: { readonly run: RunView; readonly now: number }) => {
  const at = runActivityAt(run);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 @xl:flex-nowrap">
      <span className="truncate">{run.loop}</span>
      <StatusBadge state={run.state} />
      <time
        dateTime={at}
        title={timestampLabel(at)}
        className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums"
      >
        {agoLabel(at, now)}
      </time>
    </span>
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
    <TableCell className={cn("py-3 align-top", STATUS_COLUMN)}>
      <Status row={row} now={now} />
    </TableCell>
    <TableCell className={cn("max-w-56 py-3 align-top", WIDE_COLUMN)}>
      <Runs task={row.task} />
    </TableCell>
    <TableCell className={cn("py-3 align-top", LAST_RUN_COLUMN)}>
      <LastRun run={row.last} now={now} />
    </TableCell>
    <TableCell className={cn("py-3 text-right align-top", WIDE_COLUMN)}>
      {row.task.pullRequest !== null && <PullRequest pullRequest={row.task.pullRequest} />}
    </TableCell>
  </TableRow>
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
        <div className="@container -mx-2">
          <Table aria-label={`${project.repository} tasks`}>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Task</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className={WIDE_COLUMN}>Runs</TableHead>
                <TableHead>Last run</TableHead>
                <TableHead className={cn("text-right", WIDE_COLUMN)}>Pull request</TableHead>
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
      )}
    </Page>
  );
};
