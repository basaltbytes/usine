import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { LoopName } from "@usine/core/loop";
import type { CycleBudgetUsedUpView, RunView, StalledItemView } from "@usine/orchestrator/operator";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "../api.ts";
import { runActionLabel, runActionProgress, runAgainBlocked } from "../operator-copy.ts";
import {
  type RunActionRequest,
  unchangedRunAgain,
  useRunAction,
  useRunAgain,
} from "../run-actions.ts";

/** The placement: at the end of a desk row, or under the reason on a Board card. */
type StallActionAppearance = "row" | "card";

const useRefreshDesk = () => {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["overview"] }),
      queryClient.invalidateQueries({ queryKey: ["desk"] }),
    ]);
};

const ActionButton = ({
  appearance,
  label,
  disabled,
  error,
  onClick,
}: {
  readonly appearance: StallActionAppearance;
  readonly label: string;
  readonly disabled: boolean;
  readonly error: string | null;
  readonly onClick: () => void;
}) => (
  <span
    className={cn(
      "inline-flex flex-col gap-1",
      appearance === "row" ? "items-end" : "relative z-10 items-start",
    )}
  >
    <Button
      variant={appearance === "row" ? "ghost" : "outline"}
      size={appearance === "row" ? "default" : "xs"}
      className={appearance === "row" ? "text-muted-foreground" : undefined}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {label}
    </Button>
    {error !== null && (
      <span
        role="alert"
        className={cn(
          "text-xs whitespace-normal text-destructive",
          appearance === "row" && "max-w-56 text-right",
        )}
      >
        {error}
      </span>
    )}
  </span>
);

/** Renders Approve, Retry, Mark resolved, or Mark answered for the Run that blocks the Item. */
const RunAction = ({
  appearance,
  run,
  request,
  label,
}: {
  readonly appearance: StallActionAppearance;
  readonly run: RunView;
  readonly request: RunActionRequest;
  readonly label: string;
}) => {
  const action = useRunAction();
  return (
    <ActionButton
      appearance={appearance}
      label={action.isPending ? runActionProgress[request.action] : label}
      disabled={action.isPending}
      error={action.error?.message ?? null}
      onClick={() => action.mutate({ runId: run.id, request })}
    />
  );
};

const RunAgainAction = ({
  appearance,
  run,
}: {
  readonly appearance: StallActionAppearance;
  readonly run: RunView;
}) => {
  const again = useRunAgain();
  const blocked = again.data?._tag === "CycleBlocked";
  return (
    <ActionButton
      appearance={appearance}
      label={again.isPending ? "Opening…" : runActionLabel.runAgain}
      disabled={again.isPending}
      error={blocked ? runAgainBlocked : (again.error?.message ?? null)}
      onClick={() => again.mutate(unchangedRunAgain(run))}
    />
  );
};

const ResetBudgetAction = ({
  appearance,
  reason,
}: {
  readonly appearance: StallActionAppearance;
  readonly reason: CycleBudgetUsedUpView;
}) => {
  const refresh = useRefreshDesk();
  const reset = useMutation({
    mutationFn: () =>
      api((client) => client.resetCycleBudget({ payload: { askId: reason.ask.id } })),
    onSuccess: refresh,
  });
  return (
    <ActionButton
      appearance={appearance}
      label={reset.isPending ? "Resetting…" : "Reset cycle budget"}
      disabled={reset.isPending}
      error={reset.error?.message ?? null}
      onClick={() => reset.mutate()}
    />
  );
};

const ResumeAction = ({
  appearance,
  loop,
}: {
  readonly appearance: StallActionAppearance;
  readonly loop: LoopName;
}) => {
  const refresh = useRefreshDesk();
  const resume = useMutation({
    mutationFn: () => api((client) => client.unpause({ params: { loop } })),
    onSuccess: refresh,
  });
  return (
    <ActionButton
      appearance={appearance}
      label={resume.isPending ? "Resuming…" : "Resume"}
      disabled={resume.isPending}
      error={resume.error?.message ?? null}
      onClick={() => resume.mutate()}
    />
  );
};

/** Renders the action that unblocks a stalled Item, or nothing if there is none or `readOnly` is set. */
export const StallAction = ({
  stalled,
  readOnly,
  appearance,
}: {
  readonly stalled: StalledItemView;
  readonly readOnly: boolean;
  readonly appearance: StallActionAppearance;
}) => {
  if (readOnly) return null;
  const reason = stalled.reason;
  switch (reason._tag) {
    case "AwaitingApproval":
      return reason.run.canApprove ? (
        <RunAction
          appearance={appearance}
          run={reason.run}
          request={{ action: "approve" }}
          label={runActionLabel.approve}
        />
      ) : null;
    case "SuppressedForOperator": {
      const attempt = reason.run.attempts.at(-1);
      if (!reason.run.canResolveFailure || attempt === undefined) return null;
      const question =
        attempt.outcome?._tag === "Failed" && attempt.outcome.failure._tag === "QuestionFailure";
      return (
        <RunAction
          appearance={appearance}
          run={reason.run}
          request={{ action: "resolveFailure", attemptId: attempt.id }}
          label={question ? "Mark answered" : "Mark resolved"}
        />
      );
    }
    case "CycleBudgetUsedUp":
      return <ResetBudgetAction appearance={appearance} reason={reason} />;
    case "RunFailed":
      return reason.run.canRetry ? (
        <RunAction
          appearance={appearance}
          run={reason.run}
          request={{ action: "retry" }}
          label={runActionLabel.retry}
        />
      ) : null;
    case "ClosedUnchanged":
      return reason.run.canRunAgain ? (
        <RunAgainAction appearance={appearance} run={reason.run} />
      ) : null;
    case "LoopPaused":
      return <ResumeAction appearance={appearance} loop={stalled.loop} />;
    case "WaitingForStop":
    case "QueuedForWorker":
    case "AwaitingPoll":
      return null;
  }
};
