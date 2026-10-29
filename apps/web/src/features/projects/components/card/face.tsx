import { cardAttentionLabel, cardConflictLabel } from "~/features/projects/strings";
import type { BoardLaneView, BoardTaskView, StalledItemView } from "@usine/orchestrator/operator";
import { ItemMark } from "~/components/item/mark";
import { StallAction } from "~/components/stall/action";
import { failedRun } from "~/lib/projects/failure";
import { CardLabels } from "~/features/projects/components/card/labels";
import { CardTitle } from "~/features/projects/components/card/title";
import { FailureNote } from "~/features/projects/components/card/failure-note";
import { RetryButton } from "~/features/projects/components/card/retry-button";
import { RunLine } from "~/features/projects/components/card/run-line";
import { StallNote } from "~/features/projects/components/card/stall-note";
import { type CardRunAgain } from "~/hooks/projects/run-again";
import { type RunActions } from "~/hooks/runs/actions";
import { cardLabels, currentRun, type LabelCatalog } from "~/lib/projects/card";
import { stallNamesLoop } from "~/lib/stall/strings";
import { runAgainBlocked } from "~/lib/runs/strings";
import { stallRun } from "~/lib/tasks/model";

type CardFaceProps = {
  readonly item: BoardTaskView;
  readonly lane: BoardLaneView;
  readonly catalog: LabelCatalog;
  readonly stall: StalledItemView | null;
  readonly readOnly: boolean;
  /** The card's Run actions, or `null` on the drag overlay copy. */
  readonly action: RunActions | null;
  /** The card's Run again requests, or `null` on the drag overlay copy. */
  readonly again: CardRunAgain | null;
  readonly progress: string | null;
};

export const CardFace = ({
  item,
  lane,
  catalog,
  stall,
  readOnly,
  action,
  again,
  progress,
}: CardFaceProps) => {
  const failure = failedRun(item);
  const run = currentRun(item);
  const actionError = action?.error?.message ?? null;
  const runAgainError = again?.error?.message ?? null;
  // If the stall is for the failure note's Run, the note shows it, with a suppression's action.
  const onFailure =
    stall !== null &&
    failure !== null &&
    (stall.reason._tag === "RunFailed" || stall.reason._tag === "SuppressedForOperator") &&
    stall.reason.run.id === failure.run.id;
  const stallAction =
    stall === null || action === null ? null : (
      <StallAction stalled={stall} readOnly={readOnly} appearance="card" />
    );
  // Waiting and Failed Runs explain why the card needs the operator; a blocked Item does not.
  const unexplained =
    item.needsYou && !(run?.canApprove || run?.canResolveFailure) && stall === null;
  return (
    <div className="flex min-w-0 flex-col gap-1.5 px-3">
      <p className="flex flex-wrap items-baseline gap-x-2.5 pr-6">
        {item.items.map((member) => (
          <ItemMark key={member.itemKey} item={member} className="relative z-10" />
        ))}
      </p>
      <CardTitle item={item} />
      <CardLabels labels={cardLabels(item, lane)} catalog={catalog} />
      {run !== null && <RunLine run={run} />}
      {progress !== null && (
        <p role="status" className="text-xs text-muted-foreground">
          {progress}
        </p>
      )}
      {failure !== null && (
        <FailureNote failure={failure}>
          {onFailure && stall?.reason._tag === "SuppressedForOperator" ? (
            stallAction
          ) : (
            <RetryButton failure={failure} action={action} />
          )}
        </FailureNote>
      )}
      {stall !== null && !onFailure && (
        <StallNote
          stalled={stall}
          named={(run === null || stallRun(stall)?.id !== run.id) && !stallNamesLoop(stall)}
        >
          {stallAction}
        </StallNote>
      )}
      {again?.data?._tag === "CycleBlocked" && (
        <p role="status" className="text-xs text-needs-you">
          {runAgainBlocked}
        </p>
      )}
      {actionError !== null && (
        <p className="text-xs text-destructive wrap-anywhere">{actionError}</p>
      )}
      {runAgainError !== null && (
        <p className="text-xs text-destructive wrap-anywhere">{runAgainError}</p>
      )}
      {item.conflicting && <p className="text-xs text-destructive">{cardConflictLabel}</p>}
      {unexplained && <p className="text-xs text-needs-you">{cardAttentionLabel}</p>}
    </div>
  );
};
