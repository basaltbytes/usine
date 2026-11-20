import { useQuery } from "@tanstack/react-query";
import { Link, linkOptions } from "@tanstack/react-router";
import type { ProjectId } from "@usine/core/project";
import type { BoardTaskView, RunSummaryView } from "@usine/orchestrator/operator";
import type { TitledItem } from "~/components/item/identity";
import { ItemMark } from "~/components/item/mark";
import { StateMark, StatusBadge } from "~/components/status-badge";
import { TextTooltip } from "~/components/text-tooltip";
import { Badge } from "~/components/ui/badge";
import { useNow } from "~/hooks/use-now";
import { deskQuery } from "~/lib/desk/queries";
import type { ReferencePlace } from "~/lib/references/syntax";
import { taskNumber, taskRow } from "~/lib/tasks/model";
import { statusLine } from "~/lib/tasks/status";
import { cn } from "~/lib/utils";

// A chip is at most one line of the text around it tall, so a line with one keeps its height.
const CHIP = "max-h-lh max-w-full align-text-bottom";
// A title in a sentence stops at 160px, about 24 characters, so a sentence with two chips takes at
// most one more line than its plain text in a 520px column.
const SENTENCE_TITLE = "max-w-40";

type TaskChipProps = {
  readonly project: ProjectId;
  readonly task: BoardTaskView;
  /** The task's item that the text names. */
  readonly item: TitledItem;
  readonly place: ReferencePlace;
};

/**
 * Renders a task as the Tasks list shows it, linked to its task page: `item`'s mark and title, then
 * the task's status mark and words if it has a run. A stalled task's status comes from the desk.
 * Only the title is cut: in a sentence at `SENTENCE_TITLE`, and anywhere to fit the column. In a
 * table cell, the title and the status words show in the tooltip instead.
 */
export const TaskChip = ({ project, task, item, place }: TaskChipProps) => {
  const now = useNow(30_000);
  const { data: desk } = useQuery(deskQuery());
  const row = taskRow(task, desk?.notMoving ?? []);
  const status = row === undefined ? undefined : statusLine(row, now);
  const cell = place === "cell";
  // A done task shows its done item's icon, unless `item` is that item and its mark shows it.
  const mark =
    status === undefined ? null : status.state !== "Done" ? (
      <StateMark state={status.state} className="mx-0.75" />
    ) : item.number === task.number ? null : (
      <ItemMark item={task} linked={false} numbered={false} tooltip={!cell} />
    );
  const chip = (
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
      <ItemMark item={item} linked={false} tooltip={!cell} />
      {cell ? (
        <span className="sr-only">{item.title}</span>
      ) : (
        <TextTooltip text={item.title} repeats>
          <span className={cn("min-w-0 truncate", place === "text" && SENTENCE_TITLE)}>
            {item.title}
          </span>
        </TextTooltip>
      )}
      {status !== undefined &&
        (cell ? (
          <>
            {mark}
            <span className="sr-only">{status.words}</span>
          </>
        ) : (
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 text-muted-foreground",
              mark === null && "ml-0.75",
            )}
          >
            {mark}
            {status.words}
          </span>
        ))}
    </Badge>
  );
  return cell ? (
    <TextTooltip
      text={status === undefined ? item.title : `${item.title} · ${status.words}`}
      repeats
    >
      {chip}
    </TextTooltip>
  ) : (
    chip
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
