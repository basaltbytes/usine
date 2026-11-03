import { useInfiniteQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef } from "react";
import { loadingRuns, retryRuns } from "~/features/tasks/strings";
import { taskRunsQuery } from "~/features/tasks/queries";
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
  const history = useInfiniteQuery(taskRunsQuery(task));
  const runs = history.data.pages.flatMap(({ runs }) => runs);
  const more = useRef<HTMLDivElement | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const virtual = useVirtualizer({
    count: runs.length,
    getScrollElement: () => anchor.current?.closest<HTMLElement>(".overflow-y-auto") ?? null,
    estimateSize: () => 80,
    overscan: 8,
    enabled: runs.length >= 50,
    scrollMargin: anchor.current?.offsetTop ?? 0,
  });
  const visible = virtual.getVirtualItems();
  const last = visible.at(-1)?.index ?? 0;
  useEffect(() => {
    if (history.hasNextPage && !history.isFetchingNextPage && last >= runs.length - 8)
      void history.fetchNextPage();
  }, [history.hasNextPage, history.isFetchingNextPage, history.fetchNextPage, last, runs.length]);
  useEffect(() => {
    const node = more.current;
    if (node === null || !history.hasNextPage || history.isFetchingNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some(({ isIntersecting }) => isIntersecting)) void history.fetchNextPage();
      },
      {
        root: anchor.current?.closest<HTMLElement>(".overflow-y-auto") ?? null,
        rootMargin: "200px",
      },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [history.hasNextPage, history.isFetchingNextPage, history.fetchNextPage]);
  const items = new Map(task.items.map((item) => [item.itemKey, item]));
  const named = task.items.length > 1;
  return (
    <section ref={anchor} aria-labelledby="task-runs" className="flex flex-col gap-2">
      <SectionHeading id="task-runs" title="Runs" count={task.runsTotal ?? task.runs.length} />
      {runs.length === 0 ? (
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
            {runs.length >= 50 && (
              <tbody>
                <tr aria-hidden="true">
                  <td
                    colSpan={8}
                    style={{
                      height: Math.max(0, (visible[0]?.start ?? 0) - virtual.options.scrollMargin),
                    }}
                  />
                </tr>
              </tbody>
            )}
            {(runs.length >= 50 ? visible : runs.map((_, index) => ({ index, key: index }))).map(
              (row) => {
                const run = runs[row.index];
                if (run === undefined) return null;
                const pullRequest = Option.flatMap(
                  Option.fromNullishOr(run.pullRequestUrl),
                  (url) => pullRequestAt(url, task.items),
                );
                const item = named ? (items.get(run.itemKey) ?? null) : null;
                return (
                  <TableBody
                    key={run.id}
                    data-index={row.index}
                    ref={runs.length >= 50 ? virtual.measureElement : undefined}
                  >
                    <RunRow
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
                  </TableBody>
                );
              },
            )}
            {runs.length >= 50 && (
              <tbody>
                <tr aria-hidden="true">
                  <td
                    colSpan={8}
                    style={{
                      height: Math.max(
                        0,
                        virtual.getTotalSize() -
                          ((visible.at(-1)?.end ?? 0) - virtual.options.scrollMargin),
                      ),
                    }}
                  />
                </tr>
              </tbody>
            )}
          </Table>
        </div>
      )}
      <div ref={more} aria-hidden="true" />
      {history.isFetchingNextPage && <p role="status">{loadingRuns}</p>}
      {history.isError && (
        <button type="button" onClick={() => void history.refetch()}>
          {retryRuns}
        </button>
      )}
    </section>
  );
};
