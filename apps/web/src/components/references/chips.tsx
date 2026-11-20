import { useQuery } from "@tanstack/react-query";
import { Link, linkOptions } from "@tanstack/react-router";
import type { ProjectId } from "@usine/core/project";
import type { BoardTaskView, RunSummaryView } from "@usine/orchestrator/operator";
import { cardIdentity } from "~/components/item/identity";
import { ItemMark } from "~/components/item/mark";
import { StateMark, StatusBadge } from "~/components/status-badge";
import { Badge } from "~/components/ui/badge";
import { useNow } from "~/hooks/use-now";
import { deskQuery } from "~/lib/desk/queries";
import { taskNumber, taskRow } from "~/lib/tasks/model";
import { statusLine } from "~/lib/tasks/status";

// A chip is at most one line of the text around it tall, so a line with one keeps its height.
const CHIP = "max-h-lh max-w-full align-text-bottom";
// Text that wraps but shows one line: a narrow table column can cut it short with an ellipsis.
const ONE_LINE = "min-w-0 line-clamp-1 whitespace-normal break-all";

type TaskChipProps = {
  readonly project: ProjectId;
  readonly task: BoardTaskView;
};

/**
 * Renders a task as the Tasks list shows it, linked to its task page: its name's mark and title,
 * then its status mark and words if it has a run. A stalled task's status comes from the desk.
 */
export const TaskChip = ({ project, task }: TaskChipProps) => {
  const now = useNow(30_000);
  const { data: desk } = useQuery(deskQuery());
  const { origin } = cardIdentity(task);
  const row = taskRow(task, desk?.notMoving ?? []);
  const status = row === undefined ? undefined : statusLine(row, now);
  return (
    <Badge
      variant="outline"
      data-not-typeset
      className={CHIP}
      render={
        <Link
          {...linkOptions({
            to: "/projects/$project/tasks/$number",
            params: { project, number: taskNumber(task) },
            search: { repository: task.repository },
          })}
        />
      }
    >
      <ItemMark item={origin} linked={false} />
      <span className={ONE_LINE}>{origin.title}</span>
      {status !== undefined && (
        <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground">
          {status.state === "Done" ? (
            <ItemMark item={task} linked={false} numbered={false} />
          ) : (
            <StateMark state={status.state} className="mx-0.75" />
          )}
          <span className={ONE_LINE}>{status.words}</span>
        </span>
      )}
    </Badge>
  );
};

type RunChipProps = {
  readonly project: ProjectId;
  readonly run: RunSummaryView;
};

/** Renders a run as its state mark and loop, linked to its run page. */
export const RunChip = ({ project, run }: RunChipProps) => (
  <Badge
    variant="outline"
    data-not-typeset
    className={CHIP}
    render={
      <Link
        {...linkOptions({ to: "/projects/$project/runs/$run", params: { project, run: run.id } })}
      />
    }
  >
    <StatusBadge state={run.state} label={run.loop} />
    <span className="sr-only">{run.state}</span>
  </Badge>
);
