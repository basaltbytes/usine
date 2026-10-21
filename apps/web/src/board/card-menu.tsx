import { ArrowSquareOutIcon, DotsThreeIcon } from "@phosphor-icons/react";
import type { RunId } from "@usine/core/run";
import type { BoardLaneView, BoardTaskView, RunView } from "@usine/orchestrator/operator";
import { Fragment, type ReactNode, useState } from "react";
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
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { elapsedLabel, itemKindLabel, openedTitle, runActionLabel } from "../operator-copy.ts";
import type { RunActions } from "../run-actions.ts";
import type { CardRunAgain } from "./run-again.ts";

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
          <span className="truncate">{run.loop}</span>
          <span className="ml-auto flex shrink-0 items-center gap-2 pl-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <StateMark state={run.state} />
              {run.state}
            </span>
            <time
              dateTime={run.openedAt}
              title={openedTitle(run.openedAt)}
              className="font-mono tabular-nums"
            >
              {elapsedLabel(run.openedAt)}
            </time>
          </span>
        </DropdownMenuItem>
      ))}
    </DropdownMenuSubContent>
  </DropdownMenuSub>
);

/** The card's actions, listing only those that apply now: GitHub links, the current Run's drawer
 * and operator actions, Run again on a latest Run that ended, earlier Runs, and lane moves. */
export const CardMenu = ({
  item,
  run,
  moves,
  openRun,
  action,
  again,
  className,
}: {
  readonly item: BoardTaskView;
  /** The Run the card shows, or null when it shows none. */
  readonly run: RunView | null;
  readonly moves: CardMoves;
  /** Opens a Run's drawer. */
  readonly openRun: (runId: RunId) => void;
  readonly action: RunActions;
  /** Run again for the card's Task, which opens the new Run's drawer itself. */
  readonly again: CardRunAgain;
  readonly className?: string;
}) => {
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const subject = `${itemKindLabel(item.kind).toLowerCase()} #${item.number}`;
  const past = item.runs.filter(({ id }) => id !== run?.id);
  // A Task whose latest Run succeeded or was canceled shows no Run line, so Run again names the Loop.
  const ended = item.run?.canRunAgain === true ? item.run : null;
  const groups: Array<{ readonly key: string; readonly content: ReactNode }> = [
    {
      key: "links",
      content: item.items.map((member) => (
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
      )),
    },
  ];
  if (run !== null || past.length > 0)
    groups.push({
      key: "runs",
      content: (
        <>
          {run !== null && (
            <DropdownMenuItem onClick={() => openRun(run.id)}>Open run</DropdownMenuItem>
          )}
          {past.length > 0 && <RunHistory runs={past} openRun={openRun} />}
        </>
      ),
    });
  // The card shows a sent action's progress; its menu offers no action until the answer arrives.
  const sending = action.isPending || again.isPending;
  const offered =
    ended !== null || (run !== null && (run.canApprove || run.canRetry || run.canCancel));
  if (!sending && offered)
    groups.push({
      key: "actions",
      content: (
        <>
          {run?.canApprove && (
            <DropdownMenuItem
              onClick={() => action.mutate({ runId: run.id, request: { action: "approve" } })}
            >
              {runActionLabel.approve}
            </DropdownMenuItem>
          )}
          {run?.canRetry && (
            <DropdownMenuItem
              onClick={() => action.mutate({ runId: run.id, request: { action: "retry" } })}
            >
              {runActionLabel.retry}
            </DropdownMenuItem>
          )}
          {ended !== null && (
            <DropdownMenuItem onClick={() => again.send(ended)}>
              {runActionLabel.runAgain}
              <span className="ml-auto truncate pl-4 text-xs text-muted-foreground">
                {ended.loop}
              </span>
            </DropdownMenuItem>
          )}
          {run?.canCancel && (
            <DropdownMenuItem variant="destructive" onClick={() => setConfirmingCancel(true)}>
              {runActionLabel.cancel}
            </DropdownMenuItem>
          )}
        </>
      ),
    });
  if (!moves.disabled && moves.targets.length > 0)
    groups.push({
      key: "move",
      content: (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Move to</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-40">
            {moves.targets.map((lane) => (
              <DropdownMenuItem key={lane.id} onClick={() => moves.onMove(item, lane)}>
                {lane.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ),
    });
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn(
                "text-muted-foreground hover:text-foreground aria-expanded:text-foreground",
                className,
              )}
            />
          }
          aria-label={`Actions for ${subject}`}
        >
          <DotsThreeIcon weight="bold" className="size-4" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-48">
          {groups.map(({ key, content }, index) => (
            <Fragment key={key}>
              {index > 0 && <DropdownMenuSeparator />}
              <DropdownMenuGroup>{content}</DropdownMenuGroup>
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {run !== null && (
        <AlertDialog open={confirmingCancel} onOpenChange={setConfirmingCancel}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Cancel {run.loop}?</AlertDialogTitle>
              <AlertDialogDescription>
                The run on {subject} stops, including any attempt in progress.
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
