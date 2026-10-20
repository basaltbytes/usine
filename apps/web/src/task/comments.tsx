import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import type { TaskView } from "@usine/orchestrator/operator";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { dayTimeLabel, timestampLabel } from "../operator-copy.ts";
import { projectParams } from "../overview.ts";
import { commentKindLabel, itemReference } from "./model.ts";
import { linkedRow, rowLink, SectionEmpty, SectionHeading } from "./section.tsx";

/** When a comment was posted, or, for one harvested before GitHub's times were recorded, when its
 * Attempt ended; null when neither is known. */
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

/**
 * The comments and reviews the Task's Runs posted on GitHub, newest Run first: what it is and on
 * which Item, the Run that posted it, and when it was posted. Each opens on GitHub.
 */
export const TaskComments = ({ task }: { readonly task: TaskView }) => {
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
                    <TableCell className="w-full py-3 whitespace-normal">
                      <a
                        data-row-link
                        href={comment.url}
                        target="_blank"
                        rel="noreferrer"
                        className={`font-medium ${rowLink}`}
                      >
                        {commentKindLabel(comment.kind)}
                        {item !== undefined && (
                          <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
                            on {itemReference(item)}
                          </span>
                        )}
                        <ArrowSquareOutIcon
                          className="ml-1.5 inline size-3.5 text-muted-foreground"
                          aria-label="Opens on GitHub"
                        />
                      </a>
                    </TableCell>
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
