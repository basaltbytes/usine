import type { RunId } from "@usine/core/run";
import type { TaskView } from "@usine/orchestrator/operator";
import { Option } from "effect";
import { pullRequestAt } from "~/components/item/identity";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { RunRow } from "~/features/tasks/components/runs/row";
import { SectionEmpty, SectionHeading } from "~/features/tasks/components/section";

type TaskRunsProps = {
  readonly task: TaskView;
  readonly openRun: (runId: RunId) => void;
};

/** Renders every Run on the Task's Items, newest first. */
export const TaskRuns = ({ task, openRun }: TaskRunsProps) => {
  const items = new Map(task.items.map((item) => [item.itemKey, item]));
  const named = task.items.length > 1;
  return (
    <section aria-labelledby="task-runs" className="flex flex-col gap-2">
      <SectionHeading id="task-runs" title="Runs" count={task.runs.length} />
      {task.runs.length === 0 ? (
        <SectionEmpty title="No runs yet">
          A run opens when a loop's trigger matches one of the task's items
        </SectionEmpty>
      ) : (
        <div className="-mx-2">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="hidden sm:table-cell">State</TableHead>
                <TableHead>Run</TableHead>
                <TableHead className="hidden xl:table-cell">Agent</TableHead>
                <TableHead className="hidden text-right xl:table-cell">Attempts</TableHead>
                <TableHead className="hidden text-right xl:table-cell">Duration</TableHead>
                <TableHead className="hidden xl:table-cell">Opened</TableHead>
                <TableHead className="hidden xl:table-cell">Pull request</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {task.runs.map((run) => {
                const pullRequest = Option.flatMap(
                  Option.fromNullishOr(run.pullRequestUrl),
                  (url) => pullRequestAt(url, task.items),
                );
                const item = named ? (items.get(run.itemKey) ?? null) : null;
                return (
                  <RunRow
                    key={run.id}
                    run={run}
                    item={
                      item === null ||
                      Option.exists(pullRequest, ({ number }) => number === item.number)
                        ? null
                        : item
                    }
                    pullRequest={pullRequest}
                    openRun={openRun}
                  />
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
};
