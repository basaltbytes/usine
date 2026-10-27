import { DotsThreeIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import type { RunId } from "@usine/core/run";
import type { RunView, TaskItemView, TaskView } from "@usine/orchestrator/operator";
import { Option } from "effect";
import { type ReactNode, useState } from "react";
import { FillCell } from "@/components/fill-cell";
import { pullRequestAt } from "@/components/item/identity";
import { ItemMark, type ItemRef } from "@/components/item/mark";
import { StateMark } from "@/components/status-badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";
import {
  dayTimeLabel,
  durationLabel,
  failureMessage,
  failureReason,
  retryDescription,
  runActionLabel,
  runActionProgress,
  runAgainBlocked,
  runAgainProgress,
  timestampLabel,
} from "../operator-copy.ts";
import { projectParams } from "../overview.ts";
import {
  type RunActionRequest,
  unchangedRunAgain,
  useRunAction,
  useRunAgain,
} from "../run-actions.ts";
import { EditAndRetry, type EditIntent, editApplies } from "../run-intervention/edit-and-retry.tsx";
import { ApprovalLine } from "../run-page/approval.tsx";
import { RunAgainLine } from "../run-page/run-again.tsx";
import { attemptsDuration, runFailure } from "./model.ts";
import { linkedRow, rowLink, SectionEmpty, SectionHeading } from "./section.tsx";

const COLUMNS = 8;

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Renders the Run's pull request mark above the row link. */
const PullRequest = ({ pullRequest }: { readonly pullRequest: Option.Option<ItemRef> }) =>
  Option.match(pullRequest, {
    onNone: () => null,
    onSome: (item) => <ItemMark item={item} className="relative z-10" />,
  });

const Duration = ({ run }: { readonly run: RunView }) => {
  const now = useNow(30_000);
  return Option.match(attemptsDuration(run, now), {
    onNone: () => null,
    onSome: (milliseconds) => (
      <span className="font-mono text-xs tabular-nums" title="Total attempt time">
        {durationLabel(milliseconds)}
      </span>
    ),
  });
};

const Opened = ({ run }: { readonly run: RunView }) => (
  <time
    dateTime={run.openedAt}
    title={`Opened ${timestampLabel(run.openedAt)}`}
    className="font-mono text-xs whitespace-nowrap tabular-nums"
  >
    {dayTimeLabel(run.openedAt)}
  </time>
);

/** Renders the facts that have no column below the `xl` breakpoint. */
const FoldedFacts = ({
  run,
  pullRequest,
}: {
  readonly run: RunView;
  readonly pullRequest: Option.Option<ItemRef>;
}) => (
  <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs text-muted-foreground xl:hidden">
    <span className="font-medium text-foreground sm:hidden">{run.state}</span>
    <span>{run.agent}</span>
    <span>{plural(run.attempts.length, "attempt")}</span>
    <Duration run={run} />
    <Opened run={run} />
    <PullRequest pullRequest={pullRequest} />
  </p>
);

const FailureLine = ({ run }: { readonly run: RunView }) =>
  Option.match(runFailure(run), {
    onNone: () => null,
    onSome: (failure) => (
      <p className="line-clamp-2 text-xs wrap-anywhere" title={failureMessage(failure)}>
        <span className="font-medium text-destructive">{failureReason(failure)}</span>{" "}
        <span className="text-muted-foreground">{failureMessage(failure)}</span>
      </p>
    ),
  });

/** Returns the action shown as a button next to the menu, or `null` if none. */
const primaryAction = (run: RunView): "approve" | "retry" | null =>
  run.canApprove ? "approve" : run.canRetry && run.canResolveFailure ? "retry" : null;

interface MenuEntry {
  readonly label: string;
  readonly description?: string;
  readonly destructive?: boolean;
  readonly select: () => void;
}

/** While an action is pending, shows its progress instead of the actions. */
const RowActions = ({
  run,
  onEdit,
  openRun,
  status,
}: {
  readonly run: RunView;
  readonly onEdit: (intent: EditIntent) => void;
  readonly openRun: (runId: RunId) => void;
  readonly status: (message: ReactNode) => void;
}) => {
  const action = useRunAction();
  const again = useRunAgain();
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  if (action.isPending && action.variables !== undefined)
    return (
      <span role="status" className="text-xs text-muted-foreground">
        {runActionProgress[action.variables.request.action]}
      </span>
    );
  if (again.isPending)
    return (
      <span role="status" className="text-xs text-muted-foreground">
        {runAgainProgress}
      </span>
    );
  const act = (request: RunActionRequest) =>
    action.mutate(
      { runId: run.id, request },
      {
        onSuccess: () => status(null),
        onError: (error) => status(<span className="text-destructive">{error.message}</span>),
      },
    );
  const runAgain = () =>
    again.mutate(unchangedRunAgain(run), {
      onSuccess: (result) => {
        if (result._tag === "Claimed") {
          status(null);
          openRun(result.runId);
        } else status(<span className="text-needs-you">{runAgainBlocked}</span>);
      },
      onError: (error) => status(<span className="text-destructive">{error.message}</span>),
    });
  const latest = run.attempts.at(-1);
  const primary = primaryAction(run);
  const question =
    latest?.outcome?._tag === "Failed" && latest.outcome.failure._tag === "QuestionFailure";
  const entries: Array<MenuEntry> = [];
  if (run.canApprove && primary !== "approve")
    entries.push({ label: runActionLabel.approve, select: () => act({ action: "approve" }) });
  if (run.canRetry && primary !== "retry")
    entries.push({
      label: runActionLabel.retry,
      description: retryDescription(run.agentBrain),
      select: () => act({ action: "retry" }),
    });
  if (run.canRetry) entries.push({ label: "Edit and retry", select: () => onEdit("retry") });
  if (run.canRunAgain) {
    entries.push({ label: runActionLabel.runAgain, select: runAgain });
    entries.push({ label: "Edit and run again", select: () => onEdit("runAgain") });
  }
  if (run.canResolveFailure && latest !== undefined)
    entries.push({
      label: question ? "Mark answered" : "Mark resolved",
      select: () => act({ action: "resolveFailure", attemptId: latest.id }),
    });
  if (run.canCancel)
    entries.push({
      label: runActionLabel.cancel,
      destructive: true,
      select: () => setConfirmingCancel(true),
    });
  return (
    <div className="relative z-10 flex items-center justify-end gap-1">
      {primary !== null && (
        <Button
          variant="outline"
          size="sm"
          title={primary === "retry" ? retryDescription(run.agentBrain) : undefined}
          onClick={() => act({ action: primary })}
        >
          {runActionLabel[primary]}
        </Button>
      )}
      {entries.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:text-foreground aria-expanded:text-foreground"
              />
            }
            aria-label={`Actions for the ${run.loop} run opened ${dayTimeLabel(run.openedAt)}`}
          >
            <DotsThreeIcon weight="bold" className="size-4" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-44">
            <DropdownMenuGroup>
              {entries.map(({ label, description, destructive, select }) => (
                <DropdownMenuItem
                  key={label}
                  title={description}
                  variant={destructive === true ? "destructive" : "default"}
                  onClick={select}
                >
                  {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {run.canCancel && (
        <AlertDialog open={confirmingCancel} onOpenChange={setConfirmingCancel}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Cancel {run.loop}?</AlertDialogTitle>
              <AlertDialogDescription>
                The run stops, including any attempt in progress.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{runActionLabel.keepRunning}</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  setConfirmingCancel(false);
                  act({ action: "cancel" });
                }}
              >
                {runActionLabel.confirmCancel}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
};

const RunRow = ({
  run,
  item,
  pullRequest,
  openRun,
}: {
  readonly run: RunView;
  /** The Run's Item, if the Task has more than one Item and it isn't the Run's pull request. */
  readonly item: TaskItemView | null;
  /** The pull request the Run opened, with its state from the Task. */
  readonly pullRequest: Option.Option<ItemRef>;
  readonly openRun: (runId: RunId) => void;
}) => {
  const [editing, setEditing] = useState<EditIntent | null>(null);
  const [status, setStatus] = useState<ReactNode>(null);
  return (
    <>
      <TableRow className={cn(linkedRow, "[&>td]:align-top")}>
        <TableCell className="hidden py-3 sm:table-cell">
          <span className="inline-flex items-center gap-2 text-foreground">
            <StateMark state={run.state} />
            {run.state}
          </span>
        </TableCell>
        <FillCell className="py-3 whitespace-normal">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="flex min-w-0 items-baseline gap-2">
              <StateMark state={run.state} className="self-center sm:hidden" />
              <Link
                data-row-link
                to="/projects/$owner/$name/runs/$run"
                params={{ ...projectParams(run.repository), run: run.id }}
                className={cn("font-medium wrap-anywhere", rowLink)}
              >
                {run.loop}
              </Link>
              {item !== null && <ItemMark item={item} className="relative z-10 shrink-0" />}
            </p>
            <FailureLine run={run} />
            {run.runAgain !== null && <RunAgainLine run={run} source="link" className="text-xs" />}
            {run.approval !== null && <ApprovalLine approval={run.approval} className="text-xs" />}
            <FoldedFacts run={run} pullRequest={pullRequest} />
            {status !== null && (
              <p role="status" className="text-xs">
                {status}
              </p>
            )}
          </div>
        </FillCell>
        <TableCell className="hidden py-3 xl:table-cell">{run.agent}</TableCell>
        <TableCell className="hidden py-3 text-right tabular-nums xl:table-cell">
          {run.attempts.length}
        </TableCell>
        <TableCell className="hidden py-3 text-right xl:table-cell">
          <Duration run={run} />
        </TableCell>
        <TableCell className="hidden py-3 xl:table-cell">
          <Opened run={run} />
        </TableCell>
        <TableCell className="hidden py-3 xl:table-cell">
          <PullRequest pullRequest={pullRequest} />
        </TableCell>
        <TableCell className="py-2.5">
          <RowActions run={run} onEdit={setEditing} openRun={openRun} status={setStatus} />
        </TableCell>
      </TableRow>
      {editing !== null && editApplies(run, editing) && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={COLUMNS} className="px-2 pt-1 pb-4 whitespace-normal">
            <EditAndRetry
              key={`${run.id}:${editing}`}
              run={run}
              intent={editing}
              close={() => setEditing(null)}
              openRun={openRun}
              className="max-w-2xl rounded-lg border p-4"
            />
          </TableCell>
        </TableRow>
      )}
    </>
  );
};

/** Renders every Run on the Task's Items, newest first. */
export const TaskRuns = ({
  task,
  openRun,
}: {
  readonly task: TaskView;
  readonly openRun: (runId: RunId) => void;
}) => {
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
