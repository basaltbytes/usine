import type { StatisticsView } from "@usine/orchestrator/operator";
import { ChartTable } from "~/features/overview/components/statistics/chart-table";
import { TaskScatter } from "~/features/overview/components/statistics/tasks-done/scatter";
import { WeeklyTasks } from "~/features/overview/components/statistics/tasks-done/weekly";
import { instantDayLabel, spanLabel } from "~/features/overview/strings";

type TasksDoneChartProps = { readonly statistics: StatisticsView };

/** The tasks done chart: dots per task, or weekly columns when the window counts per week. */
export const TasksDoneChart = ({ statistics }: TasksDoneChartProps) => (
  <div className="flex flex-col gap-2">
    {statistics.bucket === "day" ? (
      <TaskScatter statistics={statistics} />
    ) : (
      <WeeklyTasks statistics={statistics} />
    )}
    <ChartTable
      caption="Tasks done, time in usine"
      head={["Task", "Merged", "Duration"]}
      rows={statistics.tasks.map((task) => [
        `${task.repository} #${task.number}`,
        instantDayLabel(Date.parse(task.mergedAt)),
        spanLabel(task.durationMillis),
      ])}
    />
  </div>
);
