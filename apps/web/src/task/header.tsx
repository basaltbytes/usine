import { CaretDownIcon } from "@phosphor-icons/react";
import type { ProjectView, TaskView } from "@usine/orchestrator/operator";
import { ErrorAlert } from "@/components/error-alert";
import { LabelBadge } from "@/components/label-badge";
import { NeedsYouBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cardLabels, type LabelCatalog } from "../board/card.tsx";
import { useBoardMoves } from "../board/moves.ts";
import { itemKindLabel, moveProgressMessage } from "../operator-copy.ts";
import { itemStateLine } from "./model.ts";

/**
 * The Task's originating Item, its number linking to GitHub, and its title; then how its current
 * Item stands, its lane, and its labels. Move to relabels the current Item as a Board move does,
 * offered only while another writable lane exists and no move of this Task is saving.
 */
export const TaskHeader = ({
  task,
  project,
  disabled,
}: {
  readonly task: TaskView;
  readonly project: ProjectView;
  /** True in setup mode, where operator actions are unavailable. */
  readonly disabled: boolean;
}) => {
  const moves = useBoardMoves(project);
  const [origin] = task.items;
  const current = task.items.find(({ itemKey }) => itemKey === task.current) ?? origin;
  const placed = project.board.lanes
    .flatMap((lane) => lane.items.map((card) => ({ lane, card })))
    .find(({ card }) => card.itemKey === task.current);
  const pending =
    placed === undefined
      ? undefined
      : moves.moves.find(({ itemKey }) => itemKey === placed.card.itemKey);
  const targets =
    placed === undefined
      ? []
      : project.board.lanes.filter(
          (lane) => lane._tag === "WritableBoardLane" && lane.id !== placed.lane.id,
        );
  // The overview follows a move every second while it is pending, so the lane is read from it.
  const laneName =
    project.board.lanes.find(({ id }) => id === pending?.toLane)?.name ??
    placed?.lane.name ??
    task.lane.name;
  const laneLabels = new Set<string>(
    project.board.lanes.flatMap((lane) => (lane._tag === "WritableBoardLane" ? lane.labels : [])),
  );
  const labels =
    placed === undefined
      ? current.labels
      : cardLabels(placed.card, placed.lane).filter(
          (label) => pending === undefined || !laneLabels.has(label),
        );
  const catalog: LabelCatalog = new Map(project.labels.map((label) => [label.name, label]));
  const subject = `${itemKindLabel(current.kind).toLowerCase()} #${current.number}`;
  const movable = !disabled && !moves.isPending && pending === undefined && targets.length > 0;
  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex min-w-0 items-baseline gap-2.5">
            <a
              href={origin.url}
              target="_blank"
              rel="noreferrer"
              title={`Open ${itemKindLabel(origin.kind).toLowerCase()} #${origin.number} on GitHub`}
              className="shrink-0 font-mono text-xs text-primary underline-offset-4 hover:underline"
            >
              #{origin.number}
            </a>
            <h1 className="text-xl font-semibold text-balance wrap-anywhere">{task.title}</h1>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">
              {itemStateLine(current, current.itemKey === origin.itemKey)}
            </span>
            <span>
              Lane <span className="text-foreground">{laneName}</span>
            </span>
            {pending !== undefined && (
              <span role="status">{moveProgressMessage(pending.phase)}</span>
            )}
            {labels.length > 0 && (
              <span className="flex flex-wrap gap-1">
                {labels.map((label) => (
                  <LabelBadge key={label} name={label} label={catalog.get(label)} />
                ))}
              </span>
            )}
            {task.needsYou && <NeedsYouBadge />}
          </div>
        </div>
        {placed !== undefined && movable && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="outline" className="self-start" />}
              aria-label={`Move ${subject} to another lane`}
            >
              Move to
              <CaretDownIcon data-icon="inline-end" aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto min-w-40">
              <DropdownMenuGroup>
                {targets.map((lane) => (
                  <DropdownMenuItem key={lane.id} onClick={() => moves.moveItem(placed.card, lane)}>
                    {lane.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {moves.error !== null && <ErrorAlert className="max-w-3xl" message={moves.error.message} />}
    </header>
  );
};
