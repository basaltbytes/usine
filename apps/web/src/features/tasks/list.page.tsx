import type { ProjectView, StalledItemView } from "@usine/orchestrator/operator";
import { EmptyLine } from "~/components/overview/section";
import { Page, PageHeading } from "~/components/page";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { TaskListRow } from "~/features/tasks/components/list/row";
import { TotalsLine } from "~/features/tasks/components/list/totals";
import { USAGE_COLUMN, WIDE_COLUMN } from "~/features/tasks/lib/columns";
import { useNow } from "~/hooks/use-now";
import { taskCounts, taskRows, taskTotals } from "~/lib/tasks/model";
import { cn } from "~/lib/utils";

// The title cell is `w-full max-w-0`, so it takes the remaining width and the other columns keep
// their minimum width. Status and Runs are at most `--side` wide; beyond it, Status wraps and Runs
// truncates. `--side` is an equal share, from 7rem to 13rem, of the table width minus 26rem for the
// title and minus `--rest`, the width of the visible figure columns and the side padding. On a
// phone, Status wraps at its longest word, so the table does not scroll horizontally.
const SIDE_SHARE = [
  "@md:[--side:clamp(7rem,calc((100cqw-26rem-var(--rest))/var(--sides)),13rem)]",
  "[--rest:7rem] [--sides:1] @4xl:[--rest:16.5rem] @5xl:[--rest:23rem] @5xl:[--sides:2]",
].join(" ");

type TaskListProps = {
  readonly project: ProjectView;
  readonly stalled: ReadonlyArray<StalledItemView>;
};

/**
 * Renders the Project's Tasks that usine ran at least once, in `taskRows` order. `stalled` is the
 * desk's list of stalled Items, used for the status of stalled Tasks.
 */
export const TaskList = ({ project, stalled }: TaskListProps) => {
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
                    repository={row.task.repository}
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
