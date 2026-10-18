import { ArrowSquareOutIcon, DotsThreeVerticalIcon } from "@phosphor-icons/react";
import type { RunId } from "@usine/core/run";
import type { BoardLaneView, BoardTaskView, RunView } from "@usine/orchestrator/operator";
import { useState } from "react";
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
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { elapsedLabel, itemKindLabel, runActionLabel } from "../operator-copy.ts";
import type { RunActions } from "../run-actions.ts";

/** Where a card can move: the other writable lanes, unavailable while a move is saving. */
export interface CardMoves {
  readonly targets: ReadonlyArray<BoardLaneView>;
  readonly disabled: boolean;
  readonly onMove: (item: BoardTaskView, lane: BoardLaneView) => void;
}

const RunHistory = ({
  runs,
  openRun,
}: {
  readonly runs: ReadonlyArray<RunView>;
  readonly openRun: (runId: RunId) => void;
}) => (
  <DropdownMenuSub>
    <DropdownMenuSubTrigger>Run history</DropdownMenuSubTrigger>
    <DropdownMenuSubContent className="min-w-48">
      {[...runs].reverse().map((run) => (
        <DropdownMenuItem key={run.id} onClick={() => openRun(run.id)}>
          <span className="truncate font-mono">{run.loop}</span>
          <span className="ml-auto flex shrink-0 gap-2 text-muted-foreground">
            <span>{run.state}</span>
            <time dateTime={run.openedAt} className="tabular-nums">
              {elapsedLabel(run.openedAt)}
            </time>
          </span>
        </DropdownMenuItem>
      ))}
    </DropdownMenuSubContent>
  </DropdownMenuSub>
);

/** The card's actions: GitHub links, its Run's drawer and operator actions, and lane moves. */
export const CardMenu = ({
  item,
  moves,
  openRun,
  action,
  className,
}: {
  readonly item: BoardTaskView;
  readonly moves: CardMoves;
  readonly openRun: (runId: RunId) => void;
  readonly action: RunActions;
  readonly className?: string;
}) => {
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const run = item.run;
  const subject = `${itemKindLabel(item.kind).toLowerCase()} #${item.number}`;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn("text-muted-foreground hover:text-foreground", className)}
            />
          }
          aria-label={`Actions for ${subject}`}
        >
          <DotsThreeVerticalIcon weight="bold" className="size-4" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-48">
          <DropdownMenuGroup>
            {item.items.map((member) => (
              <DropdownMenuLinkItem
                key={member.itemKey}
                href={member.url}
                target="_blank"
                rel="noreferrer"
                closeOnClick
              >
                Open #{member.number} on GitHub
                <ArrowSquareOutIcon className="ml-auto text-muted-foreground" aria-hidden="true" />
              </DropdownMenuLinkItem>
            ))}
          </DropdownMenuGroup>
          {run !== null && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={() => openRun(run.id)}>Open Run</DropdownMenuItem>
                {item.runs.length > 1 && <RunHistory runs={item.runs} openRun={openRun} />}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem
                  disabled={!run.canApprove || action.isPending}
                  onClick={() => action.mutate({ runId: run.id, request: { action: "approve" } })}
                >
                  {runActionLabel.approve}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!run.canRetry || action.isPending}
                  onClick={() => action.mutate({ runId: run.id, request: { action: "retry" } })}
                >
                  {runActionLabel.retry}
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  disabled={!run.canCancel || action.isPending}
                  onClick={() => setConfirmingCancel(true)}
                >
                  {runActionLabel.cancel}
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={moves.disabled || moves.targets.length === 0}>
              Move to
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-40">
              {moves.targets.map((lane) => (
                <DropdownMenuItem key={lane.id} onClick={() => moves.onMove(item, lane)}>
                  {lane.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
      {run !== null && (
        <AlertDialog open={confirmingCancel} onOpenChange={setConfirmingCancel}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Cancel {run.loop}?</AlertDialogTitle>
              <AlertDialogDescription>
                The Run on {subject} stops, including any Attempt in progress.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{runActionLabel.keepRunning}</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  setConfirmingCancel(false);
                  action.mutate({ runId: run.id, request: { action: "cancel" } });
                }}
              >
                {runActionLabel.confirmCancel}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
};
