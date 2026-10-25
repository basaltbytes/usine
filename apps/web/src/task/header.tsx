import { CaretDownIcon, KanbanIcon } from "@phosphor-icons/react";
import type { ProjectView, TaskView } from "@usine/orchestrator/operator";
import { Option } from "effect";
import { ErrorAlert } from "@/components/error-alert";
import { ItemHeading } from "@/components/item/heading";
import { taskIdentity } from "@/components/item/identity";
import { itemName } from "@/components/item/mark";
import { PullRequestMarks } from "@/components/item/pull-request-marks";
import { LabelBadge } from "@/components/label-badge";
import { PageFact, PageHeader } from "@/components/page";
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
import { moveProgressMessage } from "../operator-copy.ts";

/** Shows Move to only if another writable lane exists and no move of this Task is pending. */
export const TaskHeader = ({
  task,
  project,
  disabled,
}: {
  readonly task: TaskView;
  readonly project: ProjectView;
  /** Whether operator actions are unavailable, as in setup mode. */
  readonly disabled: boolean;
}) => {
  const moves = useBoardMoves(project);
  const [first] = task.items;
  const current = task.items.find(({ itemKey }) => itemKey === task.current) ?? first;
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
  // The overview polls every second while a move is pending, so the lane name comes from it.
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
  const movable = !disabled && !moves.isPending && pending === undefined && targets.length > 0;
  const { origin, pullRequests } = taskIdentity(task.items);
  return (
    <div className="flex flex-col gap-3">
      <PageHeader
        actionsBeside="sm"
        heading={<ItemHeading variant="page" item={Option.some(origin)} title={task.title} />}
        facts={
          <>
            <PullRequestMarks pullRequests={pullRequests} />
            <PageFact icon={KanbanIcon} title="Lane">
              <span className="text-foreground">{laneName}</span>
            </PageFact>
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
          </>
        }
        {...(placed !== undefined && movable
          ? {
              actions: (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<Button variant="outline" />}
                    aria-label={`Move ${itemName(current)} to another lane`}
                  >
                    Move to
                    <CaretDownIcon data-icon="inline-end" aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-auto min-w-40">
                    <DropdownMenuGroup>
                      {targets.map((lane) => (
                        <DropdownMenuItem
                          key={lane.id}
                          onClick={() => moves.moveItem(placed.card, lane)}
                        >
                          {lane.name}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              ),
            }
          : {})}
      />
      {moves.error !== null && <ErrorAlert className="max-w-3xl" message={moves.error.message} />}
    </div>
  );
};
