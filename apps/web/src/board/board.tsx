import {
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
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
  ProjectView,
  RunView,
} from "@usine/orchestrator/operator";
import { useState } from "react";
import { ErrorAlert } from "@/components/error-alert";
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
import { DraggedCard, type LabelCatalog } from "./card.tsx";
import { BoardColumn } from "./column.tsx";
import { type BoardMoveProgress, useBoardMoves } from "./moves.ts";

/** The fallback lane collects every unrouted Item and comes first, so a drag into an
 * authored lane does not cross every column. Authored and proposed lanes keep their
 * configured order. */
export const orderLanes = (lanes: ReadonlyArray<BoardLaneView>): ReadonlyArray<BoardLaneView> => [
  ...lanes.filter(({ origin }) => origin === "fallback"),
  ...lanes.filter(({ origin }) => origin !== "fallback"),
];

/** A drop lands on a lane or on one of its cards; either way the lane is the target. */
export const laneUnder = (
  over: UniqueIdentifier,
  lanes: ReadonlyArray<BoardLaneView>,
): BoardLaneView | undefined =>
  lanes.find((lane) => lane.id === over) ??
  lanes.find((lane) => lane.items.some(({ itemKey }) => itemKey === over));

/** The lane under the pointer wins; corner distance would hand a tall empty lane's drop to the
 * cards of the lane next to it. Intersection is the fallback for keyboard moves. */
const dropCollision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  return within.length > 0 ? within : rectIntersection(args);
};

/** Shows a move in its target lane while the label write and the next poll are in flight. */
const applyMove = (
  lanes: ReadonlyArray<BoardLaneView>,
  move: BoardMoveProgress,
): ReadonlyArray<BoardLaneView> => {
  const moved = lanes.flatMap(({ items }) => items).find(({ itemKey }) => itemKey === move.itemKey);
  if (moved === undefined) return lanes;
  const laneLabels = new Set(
    lanes.flatMap((lane) => (lane._tag === "WritableBoardLane" ? lane.labels : [])),
  );
  // Placement and progress explain the pending destination; stale source-lane
  // chips would contradict it. Other labels still come from the live snapshot.
  const card = { ...moved, labels: moved.labels.filter((label) => !laneLabels.has(label)) };
  return lanes.map((lane) => {
    const items = lane.items.filter(({ itemKey }) => itemKey !== move.itemKey);
    return lane.id === move.toLane ? { ...lane, items: [card, ...items] } : { ...lane, items };
  });
};

/** Runs whose Item has no card, such as schedule Runs and quarantined Items, so they stay reachable. */
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
  <Card className="max-w-5xl">
    <CardHeader>
      <CardTitle>Runs without a card</CardTitle>
      <CardDescription>
        {runs.length} run{runs.length === 1 ? "" : "s"} whose Item has no card on this board
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
              <TableCell className="font-mono font-medium">{run.loop}</TableCell>
              <TableCell className="font-mono">{run.agent}</TableCell>
              <TableCell className="max-w-64 truncate font-mono">{run.itemKey}</TableCell>
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

/** The card being dragged and the lane it left. */
interface DragSource {
  readonly item: BoardTaskView;
  readonly lane: BoardLaneView;
}

export const ProjectBoard = ({
  project,
  disabled,
  openRun,
}: {
  readonly project: ProjectView;
  readonly disabled: boolean;
  readonly openRun: (runId: RunId) => void;
}) => {
  const [active, setActive] = useState<DragSource | null>(null);
  const [over, setOver] = useState<BoardLaneId | null>(null);
  const { moves, moveItem, isPending, error } = useBoardMoves(project);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const uncarded = runsWithoutCard(project);
  const lanes = moves.reduce(applyMove, orderLanes(project.board.lanes));
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
    <main className="flex flex-col gap-4 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-heading text-xl font-medium wrap-anywhere">{project.repository}</h1>
        {project.status === "needs-you" && <NeedsYouBadge />}
      </header>
      {project.board.lanes.some(({ origin }) => origin === "proposed") && (
        <p className="max-w-3xl text-muted-foreground">
          Proposed lanes are read-only. To enable moves, configure this project’s lanes in{" "}
          <code>repos[].lanes</code> in <code>usine.yaml</code> with the labels the Board may
          exchange, then restart <code>usine up</code>.
        </p>
      )}
      {project.board.failures.length > 0 && (
        <ErrorAlert
          className="max-w-3xl"
          title={`${project.board.failures.length} Item projection${project.board.failures.length === 1 ? " was" : "s were"} quarantined`}
          message={project.board.failures.map((failure) => failure.message).join("\n")}
        />
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={dropCollision}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={endDrag}
      >
        <div
          className="-mx-2 flex gap-2 overflow-x-auto pb-3 overscroll-x-contain scrollbar-thin"
          aria-label={`${project.repository} project board`}
        >
          {lanes.map((lane) => (
            <BoardColumn
              key={lane.id}
              lane={lane}
              lanes={lanes}
              catalog={catalog}
              targeted={
                active !== null &&
                over === lane.id &&
                lane.id !== active.lane.id &&
                lane._tag === "WritableBoardLane"
              }
              pending={pending}
              moves={moves}
              openRun={openRun}
              onMove={moveItem}
            />
          ))}
        </div>
        <DragOverlay>
          {active !== null && (
            <DraggedCard item={active.item} lane={active.lane} catalog={catalog} />
          )}
        </DragOverlay>
      </DndContext>
      {error !== null && <ErrorAlert className="max-w-3xl" message={error.message} />}
      {uncarded.length > 0 && <UncardedRuns runs={uncarded} openRun={openRun} />}
    </main>
  );
};
