import { Link } from "@tanstack/react-router";
import { isSettledItemState, type LaneItemState, type LaneName } from "@usine/config/board";
import type { RepositoryName } from "@usine/core/repository";
import type {
  BoardPullRequestView,
  ProjectView,
  RunView,
  StalledItemView,
} from "@usine/orchestrator/operator";
import { Page, PageHeading } from "@/components/page";
import { StatusBadge } from "@/components/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Toggle } from "@/components/ui/toggle";
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
  taskLoops,
  taskRows,
  taskNumber,
  taskStall,
} from "./model.ts";
import { linkedRow, rowLink } from "./section.tsx";

const pullRequestLink =
  "relative z-10 rounded-sm font-mono text-xs text-primary underline-offset-4 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/70 focus-visible:outline-solid";

// The columns follow the table's own width, since the sidebar beside a mid-size window leaves
// less room than a phone held sideways. Loops and Pull request need 56rem; below 42rem, State
// and Last run fold under the title, so the table never scrolls sideways.
const WIDE_COLUMN = "hidden @4xl:table-cell";
const MID_COLUMN = "hidden @2xl:table-cell";

/** The current Item's state as a mark and word, then the lane in subtext0. */
const ItemState = ({ state, lane }: { readonly state: LaneItemState; readonly lane: LaneName }) => (
  <span className="flex h-5 min-w-0 items-center gap-2">
    <StatusBadge state={itemStateLabel(state)} />
    <span className="truncate text-xs text-muted-foreground">{lane}</span>
  </span>
);

/** The last Run's Loop, its state, and when it was last at work, such as `12m ago`. */
const LastRun = ({ run, now }: { readonly run: RunView; readonly now: number }) => {
  const at = runActivityAt(run);
  return (
    <span className="flex min-w-0 items-center gap-2">
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

/** Why the Task is stalled, as Overview and the Board card say it; the stalled Loop goes first
 * when neither the last Run nor the fragment names it. */
const StallLine = ({
  stall,
  lastLoop,
  now,
}: {
  readonly stall: StalledItemView;
  readonly lastLoop: RunView["loop"] | undefined;
  readonly now: number;
}) => (
  <p className="mt-0.5 text-xs whitespace-normal text-muted-foreground">
    {lastLoop !== stall.loop && !stallNamesLoop(stall) && (
      <span className="font-medium text-foreground">{stall.loop} </span>
    )}
    {stallSentence(stall, now)}
  </p>
);

/** The open pull request as a link, or the merged one with its state. */
const PullRequest = ({ pullRequest }: { readonly pullRequest: BoardPullRequestView }) => (
  <span className="inline-flex items-baseline gap-2">
    <a href={pullRequest.url} target="_blank" rel="noreferrer" className={pullRequestLink}>
      #{pullRequest.number}
    </a>
    {pullRequest.state === "pr-merged" && (
      <span className="text-xs text-muted-foreground">Merged</span>
    )}
  </span>
);

const TaskListRow = ({
  row: { task, lane },
  repository,
  stall,
  now,
}: {
  readonly row: TaskRow;
  readonly repository: RepositoryName;
  readonly stall: StalledItemView | null;
  readonly now: number;
}) => {
  const loops = taskLoops(task).join(", ");
  const last = task.runs.at(-1);
  const lastRun = (
    <>
      {last !== undefined && <LastRun run={last} now={now} />}
      {stall !== null && <StallLine stall={stall} lastLoop={last?.loop} now={now} />}
    </>
  );
  return (
    <TableRow className={linkedRow}>
      <TableCell className="w-full max-w-0 py-3 align-top">
        <Link
          data-row-link
          to="/projects/$owner/$name/tasks/$number"
          params={{ ...projectParams(repository), number: taskNumber(task) }}
          className={cn("block min-w-0", rowLink)}
        >
          <ItemTitle item={task} />
        </Link>
        <div className="mt-1 flex flex-col gap-0.5 @2xl:hidden">
          <ItemState state={task.state} lane={lane} />
          {lastRun}
        </div>
      </TableCell>
      <TableCell className={cn("py-3 align-top", MID_COLUMN)}>
        <ItemState state={task.state} lane={lane} />
      </TableCell>
      <TableCell className={cn("max-w-48 py-3 align-top", WIDE_COLUMN)}>
        <p className="truncate" title={loops}>
          {loops}
        </p>
      </TableCell>
      <TableCell className="py-3 text-right align-top tabular-nums">{task.runs.length}</TableCell>
      <TableCell className={cn("min-w-56 py-3 align-top", MID_COLUMN)}>{lastRun}</TableCell>
      <TableCell className={cn("py-3 text-right align-top", WIDE_COLUMN)}>
        {task.pullRequest !== null && <PullRequest pullRequest={task.pullRequest} />}
      </TableCell>
    </TableRow>
  );
};

/**
 * A Project's Tasks as rows, the most recently active first: the open ones, and with `showDone`
 * also those whose current Item is closed, as the Done lanes hold them. `stalled` is the desk's
 * list of stalled Items, whose reason a stalled Task's row shows; `onShowDone` answers the Done
 * toggle.
 */
export const TaskList = ({
  project,
  stalled,
  showDone,
  onShowDone,
}: {
  readonly project: ProjectView;
  readonly stalled: ReadonlyArray<StalledItemView>;
  readonly showDone: boolean;
  readonly onShowDone: (show: boolean) => void;
}) => {
  const now = useNow(30_000);
  const rows = taskRows(project.board.lanes);
  const open = rows.filter(({ task }) => !isSettledItemState(task.state));
  const done = rows.length - open.length;
  const shown = showDone ? rows : open;
  return (
    <Page width="full">
      <PageHeading
        title="Tasks"
        counts={rows.length === 0 ? undefined : `${open.length} open, ${done} done`}
        actions={
          done === 0 ? undefined : (
            <Toggle variant="outline" pressed={showDone} onPressedChange={onShowDone}>
              Done
              <span className="text-muted-foreground tabular-nums">{done}</span>
            </Toggle>
          )
        }
      />
      {shown.length === 0 ? (
        <EmptyLine>{rows.length === 0 ? "No tasks" : "No open tasks"}</EmptyLine>
      ) : (
        <div className="@container -mx-2">
          <Table aria-label={`${project.repository} tasks`}>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Task</TableHead>
                <TableHead className={MID_COLUMN}>State</TableHead>
                <TableHead className={WIDE_COLUMN}>Loops</TableHead>
                <TableHead className="text-right">Runs</TableHead>
                <TableHead className={MID_COLUMN}>Last run</TableHead>
                <TableHead className={cn("text-right", WIDE_COLUMN)}>Pull request</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((row) => (
                <TaskListRow
                  key={row.task.itemKey}
                  row={row}
                  repository={project.repository}
                  stall={taskStall(stalled, row.task)}
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
