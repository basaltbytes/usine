import type { ProjectId } from "@usine/core/project";
import { RepositoryMark } from "~/components/repository-mark";
import { Link } from "@tanstack/react-router";
import type { RepositoryName } from "@usine/core/repository";
import type { BoardTaskView } from "@usine/orchestrator/operator";
import { Option } from "effect";
import { Fragment } from "react";
import { FillCell } from "~/components/fill-cell";
import { ItemHeading } from "~/components/item/heading";
import { cardIdentity } from "~/components/item/identity";
import { PullRequestMarks } from "~/components/item/pull-request-marks";
import { StateMark } from "~/components/status-badge";
import { TableCell, TableRow } from "~/components/ui/table";
import { PoolHover } from "~/features/tasks/components/list/pool-hover";
import { linkedRow, rowLink } from "~/features/tasks/components/section";
import { Status } from "~/features/tasks/components/list/status";
import { TaskCost } from "~/features/tasks/components/list/cost";
import { TaskTime } from "~/features/tasks/components/list/time";
import { SIDE_CONTENT, USAGE_COLUMN, WIDE_COLUMN } from "~/features/tasks/lib/columns";
import { tokensLabel } from "~/lib/strings";
import { taskLoops, taskNumber, type TaskRow } from "~/lib/tasks/model";
import { cn } from "~/lib/utils";

const SIDE_COLUMN = "py-3 align-top whitespace-normal";
const TOTAL_COLUMN = "py-3 text-right align-top font-mono text-xs/5 whitespace-nowrap tabular-nums";

type RunsProps = { readonly task: BoardTaskView };

/** Renders each Loop in first-run order with its last Run's state mark, then the Run count. */
const Runs = ({ task }: RunsProps) => {
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

type TaskListRowProps = {
  readonly project: ProjectId;
  readonly showRepository: boolean;
  readonly row: TaskRow;
  readonly repository: RepositoryName;
  readonly now: number;
};

export const TaskListRow = ({
  row,
  repository,
  now,
  project,
  showRepository,
}: TaskListRowProps) => (
  <TableRow className={linkedRow}>
    <FillCell className="py-3 align-top">
      <Link
        data-row-link
        to="/projects/$project/tasks/$number"
        params={{ project, number: taskNumber(row.task) }}
        search={{ repository }}
        className={cn("block min-w-0", rowLink)}
      >
        <ItemHeading
          variant="row"
          item={Option.some(cardIdentity(row.task).origin)}
          title={row.task.title}
          linked={false}
        />
      </Link>
      {showRepository && (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <RepositoryMark repository={repository} />
          <span className="truncate">{repository}</span>
        </p>
      )}
    </FillCell>
    <TableCell className={SIDE_COLUMN}>
      <Status row={row} now={now} />
    </TableCell>
    <TableCell className={cn("py-3 align-top", WIDE_COLUMN)}>
      <Runs task={row.task} />
    </TableCell>
    <TableCell className={cn("py-3 text-right align-top", WIDE_COLUMN)}>
      <PullRequestMarks
        pullRequests={cardIdentity(row.task).pullRequests}
        className="relative z-10 justify-end"
      />
    </TableCell>
    <TableCell className={TOTAL_COLUMN}>
      <TaskTime task={row.task} now={now} />
    </TableCell>
    <TableCell className={cn(TOTAL_COLUMN, USAGE_COLUMN)}>
      {row.task.usage.pools.length > 0 && (
        <PoolHover
          usage={row.task.usage}
          label={`Tokens: ${tokensLabel(row.task.usage.tokens)}. Show per pool`}
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
