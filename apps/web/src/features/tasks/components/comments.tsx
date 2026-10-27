import { Link } from "@tanstack/react-router";
import type { TaskView } from "@usine/orchestrator/operator";
import { FillCell } from "~/components/fill-cell";
import { ItemMark } from "~/components/item/mark";
import { Table, TableBody, TableCell, TableRow } from "~/components/ui/table";
import { dayTimeLabel, timestampLabel } from "~/lib/strings";
import { projectParams } from "~/lib/overview";
import { commentKindLabel } from "~/lib/tasks/model";
import {
  linkedRow,
  rowLink,
  SectionEmpty,
  SectionHeading,
} from "~/features/tasks/components/section";

/** Returns the posted time, else the Attempt's end time for comments recorded before posted times
 * were stored; `null` if neither is known. */
const commentTime = (comment: TaskView["comments"][number]) => {
  if (comment.postedAt !== null)
    return { at: comment.postedAt, title: `Posted ${timestampLabel(comment.postedAt)}` };
  if (comment.attemptEndedAt !== null)
    return {
      at: comment.attemptEndedAt,
      title: `Posted during the attempt that ended ${timestampLabel(comment.attemptEndedAt)}`,
    };
  return null;
};

type TaskCommentsProps = { readonly task: TaskView };

export const TaskComments = ({ task }: TaskCommentsProps) => {
  const runs = new Map(task.runs.map((run) => [run.id, run]));
  const items = new Map(task.items.map((item) => [item.itemKey, item]));
  return (
    <section aria-labelledby="task-comments" className="flex flex-col gap-2">
      <SectionHeading
        id="task-comments"
        title="Comments and reviews"
        count={task.comments.length}
      />
      {task.comments.length === 0 ? (
        <SectionEmpty title="No comments or reviews">
          Comments and reviews an agent posts on the task's items appear here after the attempt ends
        </SectionEmpty>
      ) : (
        <div className="-mx-2">
          <Table aria-labelledby="task-comments">
            <TableBody className="border-t">
              {task.comments.map((comment) => {
                const run = runs.get(comment.runId);
                const item = run === undefined ? undefined : items.get(run.itemKey);
                const time = commentTime(comment);
                return (
                  <TableRow key={comment.url} className={linkedRow}>
                    <FillCell className="py-3 whitespace-normal">
                      <a
                        data-row-link
                        href={comment.url}
                        target="_blank"
                        rel="noreferrer"
                        className={`font-medium ${rowLink}`}
                      >
                        {commentKindLabel(comment.kind)}
                        {item !== undefined && (
                          <span className="ml-2 text-xs font-normal text-muted-foreground">
                            on <ItemMark item={item} linked={false} />
                          </span>
                        )}
                      </a>
                    </FillCell>
                    <TableCell className="py-3">
                      {run !== undefined && (
                        <Link
                          to="/projects/$owner/$name/runs/$run"
                          params={{ ...projectParams(run.repository), run: run.id }}
                          className="relative z-10 rounded-sm text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/70 focus-visible:outline-solid"
                        >
                          {run.loop}
                        </Link>
                      )}
                    </TableCell>
                    <TableCell className="py-3 text-right">
                      {time !== null && (
                        <time
                          dateTime={time.at}
                          title={time.title}
                          className="font-mono text-xs text-muted-foreground tabular-nums"
                        >
                          {dayTimeLabel(time.at)}
                        </time>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
};
