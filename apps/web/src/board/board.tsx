import {
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  type UniqueIdentifier,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { ArrowUpRightIcon } from "@phosphor-icons/react";
import { RunId } from "@usine/core/run";
import type {
  BoardLaneId,
  BoardLaneView,
  BoardTaskView,
  LoopView,
  ProjectView,
  RunView,
  StalledItemView,
} from "@usine/orchestrator/operator";
import { useState } from "react";
import { ErrorAlert } from "@/components/error-alert";
import { PageHeading } from "@/components/page";
import { RepositoryMark } from "@/components/repository-mark";
import { NeedsYouBadge, StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { taskStall } from "../task/model.ts";
import { DraggedCard, type LabelCatalog } from "./card.tsx";
import { BoardColumn } from "./column.tsx";
import { laneFlows } from "./flow.tsx";
import { type BoardMoveProgress, useBoardMoves } from "./moves.ts";

/** Returns writable lanes first, then read-only lanes, each in configured order, with the fallback
 * lane last. */
export const orderLanes = (lanes: ReadonlyArray<BoardLaneView>): ReadonlyArray<BoardLaneView> => [
  ...lanes.filter(({ _tag }) => _tag === "WritableBoardLane"),
  ...lanes.filter(({ _tag, origin }) => _tag !== "WritableBoardLane" && origin !== "fallback"),
  ...lanes.filter(({ origin }) => origin === "fallback"),
];

/** Returns the lane of a drop target, which is either a lane or one of its cards. */
export const laneUnder = (
  over: UniqueIdentifier,
  lanes: ReadonlyArray<BoardLaneView>,
): BoardLaneView | undefined =>
  lanes.find((lane) => lane.id === over) ??
  lanes.find((lane) => lane.items.some(({ itemKey }) => itemKey === over));

/** Uses the lane under the pointer, or under the dragged card's top-left corner for a keyboard drag,
 * then falls back to intersection. Corner distance isn't used because it assigns a drop on a tall
 * empty lane to the next lane's cards. */
const dropCollision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  if (within.length > 0) return within;
  if (args.pointerCoordinates === null) {
    const corner = pointerWithin({
      ...args,
      pointerCoordinates: { x: args.collisionRect.left + 1, y: args.collisionRect.top + 1 },
    });
    if (corner.length > 0) return corner;
  }
  return rectIntersection(args);
};

/** Returns a keyboard coordinate getter: Left and Right move a drag to the top of the nearest lane
 * on that side that accepts drops; Up and Down move it between cards. */
const laneKeyboardCoordinates =
  (lanes: ReadonlyArray<BoardLaneView>): KeyboardCoordinateGetter =>
  (event, args) => {
    const right = event.code === "ArrowRight";
    if (!right && event.code !== "ArrowLeft") return sortableKeyboardCoordinates(event, args);
    event.preventDefault();
    const { collisionRect, droppableRects, droppableContainers } = args.context;
    if (collisionRect === null) return undefined;
    const ids = new Set<UniqueIdentifier>(lanes.map(({ id }) => id));
    const [next] = droppableContainers
      .getEnabled()
      .flatMap(({ id }) => {
        const rect = droppableRects.get(id);
        return rect !== undefined && ids.has(id) ? [rect] : [];
      })
      .filter(({ left }) => (right ? left > collisionRect.left : left < collisionRect.left))
      .sort((a, b) => (right ? a.left - b.left : b.left - a.left));
    return next === undefined ? undefined : { x: next.left, y: next.top };
  };

/** Returns `lanes` with the moved card in its target lane, for display while the move is pending. */
const applyMove = (
  lanes: ReadonlyArray<BoardLaneView>,
  move: BoardMoveProgress,
): ReadonlyArray<BoardLaneView> => {
  const moved = lanes.flatMap(({ items }) => items).find(({ itemKey }) => itemKey === move.itemKey);
  if (moved === undefined) return lanes;
  const laneLabels = new Set(
    lanes.flatMap((lane) => (lane._tag === "WritableBoardLane" ? lane.labels : [])),
  );
  // Removes the stale lane labels from the moved card; other labels come from the live snapshot.
  const card = { ...moved, labels: moved.labels.filter((label) => !laneLabels.has(label)) };
  return lanes.map((lane) => {
    const items = lane.items.filter(({ itemKey }) => itemKey !== move.itemKey);
    return lane.id === move.toLane ? { ...lane, items: [card, ...items] } : { ...lane, items };
  });
};

/** Returns the Runs whose Item has no card, such as schedule Runs and Runs on quarantined Items. */
export const runsWithoutCard = (project: ProjectView): ReadonlyArray<RunView> => {
  const carded = new Set(
    project.board.lanes.flatMap(({ items }) =>
      items.flatMap(({ items }) => items.map(({ itemKey }) => itemKey)),
    ),
  );
  return project.runs.filter(({ itemKey }) => !carded.has(itemKey));
};

const UncardedRuns = ({
  runs,
  openRun,
}: {
  readonly runs: ReadonlyArray<RunView>;
  readonly openRun: (runId: RunId) => void;
}) => (
  // Sticks to the left edge of the Board's scroll area and is no wider than the scroll container.
  <Card className="sticky left-4 w-[min(64rem,calc(100cqw-2rem))] md:left-5 md:w-[min(64rem,calc(100cqw-2.5rem))]">
    <CardHeader>
      <CardTitle>Runs without a card</CardTitle>
      <CardDescription>
        {runs.length} run{runs.length === 1 ? "" : "s"} with no card on this board
      </CardDescription>
    </CardHeader>
    <CardContent>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Loop</TableHead>
            <TableHead>Agent</TableHead>
            <TableHead>Item</TableHead>
            <TableHead>State</TableHead>
            <TableHead className="w-0" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((run) => (
            <TableRow key={run.id} className="cursor-pointer" onClick={() => openRun(run.id)}>
              <TableCell className="font-medium">{run.loop}</TableCell>
              <TableCell>{run.agent}</TableCell>
              <TableCell className="max-w-64 truncate font-mono text-xs">{run.itemKey}</TableCell>
              <TableCell>
                <StatusBadge state={run.state} />
              </TableCell>
              <TableCell className="text-right">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Open run ${run.id}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    openRun(run.id);
                  }}
                >
                  <ArrowUpRightIcon aria-hidden="true" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </CardContent>
  </Card>
);

interface DragSource {
  readonly item: BoardTaskView;
  readonly lane: BoardLaneView;
}

/**
 * `stalled` is the desk's list of stalled Items, whose reasons are shown on their cards; `disabled`
 * turns off moves and actions during setup.
 */
export const ProjectBoard = ({
  project,
  loops,
  stalled,
  disabled,
  openRun,
}: {
  readonly project: ProjectView;
  readonly loops: ReadonlyArray<LoopView>;
  readonly stalled: ReadonlyArray<StalledItemView>;
  readonly disabled: boolean;
  readonly openRun: (runId: RunId) => void;
}) => {
  const [active, setActive] = useState<DragSource | null>(null);
  const [over, setOver] = useState<BoardLaneId | null>(null);
  const { moves, moveItem, isPending, error } = useBoardMoves(project);
  const uncarded = runsWithoutCard(project);
  const lanes = moves.reduce(applyMove, orderLanes(project.board.lanes));
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: laneKeyboardCoordinates(lanes) }),
  );
  const flows = laneFlows(lanes, loops);
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
    <div className="flex min-h-96 flex-1 flex-col gap-4 pt-5">
      <PageHeading
        title={project.repository}
        leading={<RepositoryMark repository={project.repository} size="title" />}
        counts={`${lanes.length} lane${lanes.length === 1 ? "" : "s"}, ${itemCount} item${itemCount === 1 ? "" : "s"}`}
        className="px-4 md:px-5"
      >
        {project.status === "needs-you" && <NeedsYouBadge />}
      </PageHeading>
      {project.board.lanes.some(({ origin }) => origin === "proposed") && (
        <p className="mx-4 max-w-3xl text-muted-foreground md:mx-5">
          Proposed lanes are read-only. To enable moves, add lanes with labels for this project
          under <code>repos[].lanes</code> in <code>usine.yaml</code>, then reload the configuration
          from Configuration &gt; Loops.
        </p>
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
          className="@container min-h-0 flex-1 overflow-auto overscroll-contain"
          aria-label={`${project.repository} project board`}
        >
          <div className="flex w-max min-w-full flex-col gap-6 px-4 pb-4 md:px-5">
            <div className="flex gap-3">
              {lanes.map((lane) => (
                <BoardColumn
                  key={lane.id}
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
                  repository={project.repository}
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
              lane={active.lane}
              catalog={catalog}
              repository={project.repository}
              stall={stallOf(active.item)}
            />
          )}
        </DragOverlay>
      </DndContext>
    </div>
  );
};
