import { proposedLanesHint } from "~/features/projects/strings";
import {
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { RunId } from "@usine/core/run";
import type {
  BoardLaneId,
  BoardLaneView,
  BoardTaskView,
  LoopView,
  ProjectView,
  StalledItemView,
} from "@usine/orchestrator/operator";
import { projectId, projectName } from "~/lib/overview";
import { useState } from "react";
import { ErrorAlert } from "~/components/error-alert";
import { PageHeading } from "~/components/page";
import { RepositoryMark } from "~/components/repository-mark";
import { NeedsYouBadge } from "~/components/status-badge";
import { BoardColumn } from "~/features/projects/components/column";
import { DraggedCard } from "~/features/projects/components/card/dragged";
import { laneFlows } from "~/features/projects/components/flow";
import { UncardedRuns } from "~/features/projects/components/uncarded-runs";
import {
  applyMove,
  dropCollision,
  laneKeyboardCoordinates,
  laneUnder,
  orderLanes,
  runsWithoutCard,
} from "~/features/projects/lib/board";
import { useBoardMoves } from "~/hooks/projects/moves";
import { type LabelCatalog } from "~/lib/projects/card";
import { taskStall } from "~/lib/tasks/model";

interface DragSource {
  readonly item: BoardTaskView;
  readonly lane: BoardLaneView;
}

type ProjectBoardProps = {
  readonly project: ProjectView;
  readonly loops: ReadonlyArray<LoopView>;
  readonly stalled: ReadonlyArray<StalledItemView>;
  readonly disabled: boolean;
  readonly openRun: (runId: RunId) => void;
};

/**
 * `stalled` is the desk's list of stalled Items, whose reasons are shown on their cards; `disabled`
 * turns off moves and actions during setup.
 */
export const ProjectBoard = ({ project, loops, stalled, disabled, openRun }: ProjectBoardProps) => {
  const [active, setActive] = useState<DragSource | null>(null);
  const [over, setOver] = useState<BoardLaneId | null>(null);
  const { moves, moveItem, isPending, error } = useBoardMoves(project);
  const uncarded = runsWithoutCard(project);
  const lanes = moves.reduce(applyMove, orderLanes(project.board.lanes));
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: laneKeyboardCoordinates(lanes) }),
  );
  const flows = laneFlows(
    lanes,
    project.id === undefined
      ? loops
      : loops.filter((loop) => loop.name.startsWith(`${project.id}/`)),
  );
  const itemCount = lanes.reduce((total, lane) => total + lane.items.length, 0);
  const stallOf = (task: BoardTaskView): StalledItemView | null => taskStall(stalled, task);
  const catalog: LabelCatalog = new Map(project.labels.map((label) => [label.name, label]));
  const pending = disabled || isPending;
  const endDrag = () => {
    setActive(null);
    setOver(null);
  };
  const onDragStart = ({ active: dragged }: DragStartEvent) => {
    const lane = lanes.find(({ items }) => items.some(({ itemKey }) => itemKey === dragged.id));
    const item = lane?.items.find(({ itemKey }) => itemKey === dragged.id);
    setActive(lane === undefined || item === undefined ? null : { item, lane });
  };
  const onDragOver = ({ over: target }: DragOverEvent) =>
    setOver(target === null ? null : (laneUnder(target.id, lanes)?.id ?? null));
  const onDragEnd = ({ over: target }: DragEndEvent) => {
    endDrag();
    if (target === null || active === null) return;
    const lane = laneUnder(target.id, lanes);
    if (lane !== undefined) moveItem(active.item, lane);
  };
  return (
    <div className="flex min-w-0 min-h-96 flex-1 flex-col gap-4 pt-5">
      <PageHeading
        title={projectName(project)}
        leading={<RepositoryMark repository={project.repository} size="title" />}
        counts={`${lanes.length} lane${lanes.length === 1 ? "" : "s"}, ${itemCount} item${itemCount === 1 ? "" : "s"}`}
        className="px-4 md:px-5"
      >
        {project.status === "needs-you" && <NeedsYouBadge />}
      </PageHeading>
      {project.board.lanes.some(({ origin }) => origin === "proposed") && (
        <p className="mx-4 max-w-3xl text-muted-foreground md:mx-5">{proposedLanesHint}</p>
      )}
      {project.board.failures.length > 0 && (
        <ErrorAlert
          className="mx-4 max-w-3xl md:mx-5"
          title={`${project.board.failures.length} ${project.board.failures.length === 1 ? "item" : "items"} not shown on the board`}
          message={project.board.failures.map((failure) => failure.message).join("\n")}
        />
      )}
      {error !== null && <ErrorAlert className="mx-4 max-w-3xl md:mx-5" message={error.message} />}
      <DndContext
        sensors={sensors}
        collisionDetection={dropCollision}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={endDrag}
      >
        <div
          className="min-h-0 flex-1 overflow-auto overscroll-contain [container-type:size]"
          aria-label={`${projectName(project)} project board`}
        >
          <div className="flex w-max min-w-full flex-col gap-6 px-4 pb-4 md:px-5">
            {/* Fills the visible height so each lane scrolls its own cards. */}
            <div className="flex h-[calc(100cqh-1rem)] min-h-80 shrink-0 gap-3">
              {lanes.map((lane) => (
                <BoardColumn
                  key={lane.id}
                  project={projectId(project)}
                  showRepository={project.repositories.length > 1}
                  lane={lane}
                  lanes={lanes}
                  flow={flows.get(lane.id)}
                  catalog={catalog}
                  targeted={
                    active !== null &&
                    over === lane.id &&
                    lane.id !== active.lane.id &&
                    lane._tag === "WritableBoardLane"
                  }
                  pending={pending}
                  readOnly={disabled}
                  moves={moves}
                  stallOf={stallOf}
                  openRun={openRun}
                  onMove={moveItem}
                />
              ))}
            </div>
            {uncarded.length > 0 && <UncardedRuns runs={uncarded} openRun={openRun} />}
          </div>
        </div>
        <DragOverlay>
          {active !== null && (
            <DraggedCard
              item={active.item}
              project={projectId(project)}
              showRepository={project.repositories.length > 1}
              lane={active.lane}
              catalog={catalog}
              stall={stallOf(active.item)}
            />
          )}
        </DragOverlay>
      </DndContext>
    </div>
  );
};
