import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AttemptTask } from "@usine/core/attempt";
import type { LoopName } from "@usine/core/loop";
import {
  type CycleBudgetUsedUpView,
  EditAndRetry,
  type RunView,
  type StalledItemView,
} from "@usine/orchestrator/operator";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "../api.ts";
import { runActionLabel, runActionProgress, runAgainBlocked } from "../operator-copy.ts";
import { type RunActionRequest, useRunAction, useRunAgain } from "../run-actions.ts";
import { stallSentence } from "./copy.ts";
import { EmptyLine, ItemTitle, RunPageLink, RunRow } from "./section.tsx";

const ROW_ACTION = "text-muted-foreground";

/** Refreshes what the desk and every screen show after an action on a row. */
const useRefreshDesk = () => {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["overview"] }),
      queryClient.invalidateQueries({ queryKey: ["desk"] }),
    ]);
};

/** Approve, Retry, or Mark resolved or answered, on the Run that keeps the Item from moving. */
const RunAction = ({
  run,
  request,
  label,
}: {
  readonly run: RunView;
  readonly request: RunActionRequest;
  readonly label: string;
}) => {
  const action = useRunAction();
  return (
    <ActionButton
      label={action.isPending ? runActionProgress[request.action] : label}
      disabled={action.isPending}
      error={action.error?.message ?? null}
      onClick={() => action.mutate({ runId: run.id, request })}
    />
  );
};

const RunAgainAction = ({ run }: { readonly run: RunView }) => {
  const again = useRunAgain(run.id);
  const blocked = again.data?._tag === "CycleBlocked";
  return (
    <ActionButton
      label={again.isPending ? "Opening…" : runActionLabel.runAgain}
      disabled={again.isPending}
      error={blocked ? runAgainBlocked : (again.error?.message ?? null)}
      onClick={() =>
        again.mutate(new EditAndRetry({ task: AttemptTask.make(run.task), agent: run.agent }))
      }
    />
  );
};

const ResetBudgetAction = ({ reason }: { readonly reason: CycleBudgetUsedUpView }) => {
  const refresh = useRefreshDesk();
  const reset = useMutation({
    mutationFn: () =>
      api((client) => client.resetCycleBudget({ payload: { askId: reason.ask.id } })),
    onSuccess: refresh,
  });
  return (
    <ActionButton
      label={reset.isPending ? "Resetting…" : "Reset cycle budget"}
      disabled={reset.isPending}
      error={reset.error?.message ?? null}
      onClick={() => reset.mutate()}
    />
  );
};

const ResumeAction = ({ loop }: { readonly loop: LoopName }) => {
  const refresh = useRefreshDesk();
  const resume = useMutation({
    mutationFn: () => api((client) => client.unpause({ params: { loop } })),
    onSuccess: refresh,
  });
  return (
    <ActionButton
      label={resume.isPending ? "Resuming…" : "Resume"}
      disabled={resume.isPending}
      error={resume.error?.message ?? null}
      onClick={() => resume.mutate()}
    />
  );
};

const ActionButton = ({
  label,
  disabled,
  error,
  onClick,
}: {
  readonly label: string;
  readonly disabled: boolean;
  readonly error: string | null;
  readonly onClick: () => void;
}) => (
  <span className="inline-flex flex-col items-end gap-1">
    <Button
      variant="ghost"
      className={ROW_ACTION}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {label}
    </Button>
    {error !== null && (
      <span role="alert" className="max-w-56 text-right text-xs whitespace-normal text-destructive">
        {error}
      </span>
    )}
  </span>
);

/** The one action that moves the Item again, when the operator has one; none otherwise. */
const StallAction = ({
  stalled,
  readOnly,
}: {
  readonly stalled: StalledItemView;
  readonly readOnly: boolean;
}) => {
  if (readOnly) return null;
  const reason = stalled.reason;
  switch (reason._tag) {
    case "AwaitingApproval":
      return reason.run.canApprove ? (
        <RunAction
          run={reason.run}
          request={{ action: "approve" }}
          label={runActionLabel.approve}
        />
      ) : null;
    case "HeldForOperator": {
      const attempt = reason.run.attempts.at(-1);
      if (!reason.run.canResolveFailure || attempt === undefined) return null;
      const question =
        attempt.outcome?._tag === "Failed" && attempt.outcome.failure._tag === "QuestionFailure";
      return (
        <RunAction
          run={reason.run}
          request={{ action: "resolveFailure", attemptId: attempt.id }}
          label={question ? "Mark answered" : "Mark resolved"}
        />
      );
    }
    case "CycleBudgetUsedUp":
      return <ResetBudgetAction reason={reason} />;
    case "RunFailed":
      return reason.run.canRetry ? (
        <RunAction run={reason.run} request={{ action: "retry" }} label={runActionLabel.retry} />
      ) : null;
    case "ClosedUnchanged":
      return reason.run.canRunAgain ? <RunAgainAction run={reason.run} /> : null;
    case "LoopPaused":
      return <ResumeAction loop={stalled.loop} />;
    case "QueuedForWorker":
    case "AwaitingPoll":
      return null;
  }
};

const reasonRun = ({ reason }: StalledItemView): RunView | null =>
  "run" in reason ? reason.run : null;

const StalledRow = ({
  stalled,
  now,
  readOnly,
  narrow,
}: {
  readonly stalled: StalledItemView;
  readonly now: number;
  readonly readOnly: boolean;
  /** Below `md` the row is one cell: the Item, its Loop, the reason, then the action. */
  readonly narrow: boolean;
}) => {
  const run = reasonRun(stalled);
  const title = <ItemTitle item={stalled.item} />;
  const item = run === null ? title : <RunPageLink run={run}>{title}</RunPageLink>;
  const action = <StallAction stalled={stalled} readOnly={readOnly} />;
  if (narrow)
    return (
      <RunRow run={run}>
        <TableCell className="w-full max-w-0 py-3 align-top whitespace-normal">
          {item}
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{stalled.loop}</p>
          <p className="mt-1 text-sm text-foreground/90">{stallSentence(stalled, now)}</p>
          <div className="-ml-2.5 empty:hidden [&>span]:items-start">{action}</div>
        </TableCell>
      </RunRow>
    );
  return (
    <RunRow run={run}>
      <TableCell className="w-2/5 max-w-0 py-3 align-top whitespace-normal">{item}</TableCell>
      <TableCell className="py-3 align-top">{stalled.loop}</TableCell>
      <TableCell className="w-3/5 py-3 align-top whitespace-normal text-foreground/90">
        {stallSentence(stalled, now)}
      </TableCell>
      <TableCell className="py-2 text-right align-top">{action}</TableCell>
    </RunRow>
  );
};

/**
 * Every Item a Loop's trigger matches with no Attempt running on it, with the reason and the
 * action that moves it again. A row whose reason names a Run opens that Run's page.
 * `readOnly` hides the actions while the factory needs setup; `polled` is false until a poll of
 * some repository has finished, when no Item has been matched yet.
 */
export const NotMoving = ({
  stalled,
  now,
  readOnly,
  polled,
}: {
  readonly stalled: ReadonlyArray<StalledItemView>;
  readonly now: number;
  readonly readOnly: boolean;
  readonly polled: boolean;
}) => {
  const narrow = useIsMobile();
  if (stalled.length === 0)
    return (
      <EmptyLine>
        {polled
          ? "Every Item a Loop matches has an Attempt running on it."
          : "Items are matched once the first poll finishes."}
      </EmptyLine>
    );
  return (
    <div className="-mx-2">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Item</TableHead>
            {!narrow && (
              <>
                <TableHead>Loop</TableHead>
                <TableHead>Why</TableHead>
                <TableHead>
                  <span className="sr-only">Action</span>
                </TableHead>
              </>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {stalled.map((entry) => (
            <StalledRow
              key={`${entry.loop}:${entry.item.itemKey}`}
              stalled={entry}
              now={now}
              readOnly={readOnly}
              narrow={narrow}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
};
