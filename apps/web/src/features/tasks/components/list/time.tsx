import type { BoardTaskView } from "@usine/orchestrator/operator";
import { LowerBoundMark } from "~/features/tasks/components/list/lower-bound-mark";
import { durationLabel } from "~/lib/strings";
import { taskDuration, untimedNote } from "~/lib/tasks/model";

type TaskTimeProps = { readonly task: BoardTaskView; readonly now: number };

/** Renders the total Attempt time, which keeps counting while an Attempt runs, or nothing before any Attempt starts. */
export const TaskTime = ({ task, now }: TaskTimeProps) => {
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
