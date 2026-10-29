import type { RepositoryName } from "@usine/core/repository";
import { RepositoryFilter } from "~/components/repository-filter";
import { projectId, projectName } from "~/lib/overview";
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
  readonly repository?: RepositoryName | undefined;
  readonly onRepositoryChange?: (repository: RepositoryName | undefined) => void;
  readonly project: ProjectView;
  readonly stalled: ReadonlyArray<StalledItemView>;
};

/**
 * Renders the Project's Tasks that usine ran at least once, in `taskRows` order. `stalled` is the
 * desk's list of stalled Items, used for the status of stalled Tasks.
 */
export const TaskList = ({ project, stalled, repository, onRepositoryChange }: TaskListProps) => {
  const now = useNow(30_000);
  const rows = taskRows(project.board.lanes, stalled).filter(
    (row) => repository === undefined || row.task.repository === repository,
  );
  return (
    <Page width="full">
      <PageHeading title="Tasks" counts={taskCounts(rows)} />
      {project.repositories.length > 1 && onRepositoryChange !== undefined && (
        <RepositoryFilter
          repositories={project.repositories}
          value={repository}
          onChange={onRepositoryChange}
        />
      )}
      {rows.length === 0 ? (
        <EmptyLine>No runs yet</EmptyLine>
      ) : (
        <>
          <TotalsLine totals={taskTotals(rows, now)} />
          <div className="@container -mx-2">
            <Table aria-label={`${projectName(project)} tasks`} className={SIDE_SHARE}>
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
                    project={projectId(project)}
                    showRepository={project.repositories.length > 1}
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
