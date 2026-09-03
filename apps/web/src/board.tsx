import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { pointerWithin, rectIntersection, type CollisionDetection } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { ArrowUpRightIcon, CaretDownIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Item, Repository, Run } from "@usine/core";
import type {
  BoardItemView,
  BoardLaneView,
  LabelView,
  ProjectView,
  RunView,
} from "@usine/orchestrator";
import { useState } from "react";
import { ErrorAlert } from "@/components/error-alert";
import { LabelBadge } from "@/components/label-badge";
import { NeedsYouBadge, StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { ApiOk, api } from "./api.ts";
import { failureMessage } from "./operator-copy.ts";

export const itemFailure = (item: BoardItemView): string | null => {
  const failedRun =
    item.runs.find(({ state }) => state === "Failed") ??
    (item.run?.state === "Failed" ? item.run : null);
  if (failedRun === null) return null;
  const attempts = failedRun.attempts;
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const outcome = attempts[index]?.outcome;
    if (outcome?._tag === "Failed") return failureMessage(outcome.failure);
  }
  return null;
};

/** The fallback lane holds every unrouted Item, so it leads the board: a drag into an
 * authored lane must not cross every column first. Authored and proposed lanes keep
 * their configured order. */
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

const laneOf = (
  itemKey: Item.ItemKey,
  lanes: ReadonlyArray<BoardLaneView>,
): BoardLaneView | undefined =>
  lanes.find((lane) => lane.items.some((item) => item.itemKey === itemKey));

/** The lane under the pointer wins; corner distance would hand a tall empty lane's drop to the
 * cards of the lane next to it. Intersection is the fallback for keyboard moves. */
const dropCollision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  return within.length > 0 ? within : rectIntersection(args);
};

export interface PendingMove {
  readonly itemKey: Item.ItemKey;
  readonly toLane: BoardLaneView["id"];
}

/** Shows a move in its target lane while the label write and the next poll are in flight. */
export const applyMove = (
  lanes: ReadonlyArray<BoardLaneView>,
  move: PendingMove | null,
): ReadonlyArray<BoardLaneView> => {
  if (move === null) return lanes;
  const moved = lanes.flatMap(({ items }) => items).find(({ itemKey }) => itemKey === move.itemKey);
  if (moved === undefined) return lanes;
  return lanes.map((lane) => {
    const items = lane.items.filter(({ itemKey }) => itemKey !== move.itemKey);
    return lane.id === move.toLane ? { ...lane, items: [moved, ...items] } : { ...lane, items };
  });
};

type LabelCatalog = ReadonlyMap<string, LabelView>;

/** The keyboard and assistive-technology path for a lane move; drag stays the fast path (#75). */
export interface MoveMenu {
  readonly targets: ReadonlyArray<BoardLaneView>;
  readonly disabled: boolean;
  readonly onMove: (item: BoardItemView, lane: BoardLaneView) => void;
}

const CardBody = ({
  item,
  catalog,
  openRun,
  move,
}: {
  readonly item: BoardItemView;
  readonly catalog: LabelCatalog;
  readonly openRun: (runId: Run.RunId) => void;
  readonly move?: MoveMenu;
}) => {
  const failure = itemFailure(item);
  const run = item.run;
  const visibleRuns = item.runs.filter(({ state }) => state === "Waiting" || state === "Failed");
  const runsToShow = visibleRuns.length > 0 ? visibleRuns : run === null ? [] : [run];
  const moveTargets = move?.targets ?? [];
  const titleClass =
    "h-auto justify-start p-0 text-left text-xs/relaxed font-medium whitespace-normal text-card-foreground hover:text-primary";
  return (
    <>
      <CardHeader className="gap-0.5">
        <CardDescription className="font-mono">
          {item.kind === "pr" ? "PR" : "Issue"} #{item.number}
        </CardDescription>
        <CardTitle className="font-sans text-xs/relaxed">
          {run === null ? (
            <Button
              variant="link"
              className={titleClass}
              nativeButton={false}
              render={<a href={item.url} target="_blank" rel="noreferrer" draggable={false} />}
            >
              {item.title}
            </Button>
          ) : (
            <Button variant="link" className={titleClass} onClick={() => openRun(run.id)}>
              {item.title}
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      {(item.labels.length > 0 ||
        runsToShow.length > 0 ||
        item.needsYou ||
        failure !== null ||
        moveTargets.length > 0) && (
        <CardContent className="flex flex-col items-start gap-2">
          {item.labels.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {item.labels.map((label) => (
                <LabelBadge key={label} name={label} label={catalog.get(label)} />
              ))}
            </div>
          )}
          {runsToShow.map((cardRun) => (
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 gap-2"
              key={cardRun.id}
              onClick={() => openRun(cardRun.id)}
            >
              <StatusBadge state={cardRun.state} />
              <span className="text-muted-foreground">{cardRun.agent}</span>
            </Button>
          ))}
          {item.needsYou && <NeedsYouBadge />}
          {failure !== null && <p className="text-destructive wrap-anywhere">{failure}</p>}
          {visibleRuns.some(({ state }) => state === "Waiting") && (
            <p className="text-needs-you">A run on this item is waiting for approval.</p>
          )}
          {runsToShow.some(({ state }) => state === "Queued") && (
            <p className="text-muted-foreground">Approved. Waiting for a free worker slot.</p>
          )}
          {move !== undefined && moveTargets.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={move.disabled}
                render={<Button variant="ghost" size="sm" className="-ml-2" />}
                aria-label={`Move ${item.kind === "pr" ? "PR" : "issue"} #${item.number} to a lane`}
              >
                Move to
                <CaretDownIcon aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {moveTargets.map((lane) => (
                  <DropdownMenuItem key={lane.id} onClick={() => move.onMove(item, lane)}>
                    {lane.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </CardContent>
      )}
    </>
  );
};

const cardClass = (needsYou: boolean) => cn("gap-2.5", needsYou && "ring-needs-you/50");

const BoardCard = ({
  item,
  catalog,
  disabled,
  openRun,
  move,
}: {
  readonly item: BoardItemView;
  readonly catalog: LabelCatalog;
  readonly disabled: boolean;
  readonly openRun: (runId: Run.RunId) => void;
  readonly move: MoveMenu;
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.itemKey,
    disabled,
  });
  return (
    <Card
      ref={setNodeRef}
      size="sm"
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        cardClass(item.needsYou),
        !disabled && "cursor-grab touch-none",
        isDragging && "opacity-40",
      )}
      {...attributes}
      {...listeners}
    >
      <CardBody item={item} catalog={catalog} openRun={openRun} move={move} />
    </Card>
  );
};

const BoardLane = ({
  lane,
  lanes,
  catalog,
  dragging,
  pending,
  openRun,
  onMove,
}: {
  readonly lane: BoardLaneView;
  readonly lanes: ReadonlyArray<BoardLaneView>;
  readonly catalog: LabelCatalog;
  readonly dragging: boolean;
  readonly pending: boolean;
  readonly openRun: (runId: Run.RunId) => void;
  readonly onMove: (item: BoardItemView, lane: BoardLaneView) => void;
}) => {
  const move: MoveMenu = {
    targets: lanes.filter((other) => other._tag === "WritableBoardLane" && other.id !== lane.id),
    disabled: pending,
    onMove,
  };
  const writable = lane._tag === "WritableBoardLane";
  const { setNodeRef, isOver } = useDroppable({ id: lane.id, disabled: !writable || pending });
  return (
    <Card
      ref={setNodeRef}
      size="sm"
      aria-label={`${lane.name} lane`}
      className={cn(
        "w-72 shrink-0 bg-muted/30 transition-shadow",
        dragging && writable && "ring-run-active/50",
        isOver && writable && "ring-run-active",
      )}
    >
      <CardHeader>
        <CardTitle className="wrap-anywhere">{lane.name}</CardTitle>
        <CardDescription>
          {lane.items.length} item{lane.items.length === 1 ? "" : "s"}
        </CardDescription>
        {lane.sources.length > 0 && (
          <CardAction className="flex flex-wrap justify-end gap-1">
            {lane.sources.map((source) =>
              "label" in source ? (
                <LabelBadge
                  key={`label:${source.label}`}
                  name={source.label}
                  label={catalog.get(source.label)}
                />
              ) : (
                <Badge variant="secondary" className="font-mono" key={`state:${source.state}`}>
                  {source.state}
                </Badge>
              ),
            )}
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex min-h-40 flex-col gap-2">
        <SortableContext
          items={lane.items.map(({ itemKey }) => itemKey)}
          strategy={verticalListSortingStrategy}
        >
          {lane.items.length === 0 && <p className="text-muted-foreground">No items.</p>}
          {lane.items.map((item) => (
            <BoardCard
              key={item.itemKey}
              item={item}
              catalog={catalog}
              disabled={pending}
              openRun={openRun}
              move={move}
            />
          ))}
        </SortableContext>
      </CardContent>
    </Card>
  );
};

/** Runs whose Item has no card yet (schedule Runs, quarantined Items) stay reachable here. */
export const runsWithoutCard = (project: ProjectView): ReadonlyArray<RunView> => {
  const carded = new Set(
    project.board.lanes.flatMap(({ items }) => items.map(({ itemKey }) => itemKey)),
  );
  return project.runs.filter(({ itemKey }) => !carded.has(itemKey));
};

const UncardedRuns = ({
  runs,
  openRun,
}: {
  readonly runs: ReadonlyArray<RunView>;
  readonly openRun: (runId: Run.RunId) => void;
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

export const ProjectBoard = ({
  project,
  disabled,
  openRun,
}: {
  readonly project: ProjectView;
  readonly disabled: boolean;
  readonly openRun: (runId: Run.RunId) => void;
}) => {
  const queryClient = useQueryClient();
  const [active, setActive] = useState<BoardItemView | null>(null);
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const uncarded = runsWithoutCard(project);
  const move = useMutation({
    mutationFn: ({ item, lane }: { readonly item: Item.Number; readonly lane: BoardLaneView }) => {
      const { owner, name } = Repository.parts(project.repository);
      return api(
        `/api/projects/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/items/${item}/lane`,
        ApiOk,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ toLane: lane.id }),
        },
      );
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["overview"] }),
    onSettled: () => setPendingMove(null),
  });
  const lanes = applyMove(orderLanes(project.board.lanes), pendingMove);
  const catalog: LabelCatalog = new Map(project.labels.map((label) => [label.name, label]));
  const pending = disabled || move.isPending;
  const onDragStart = ({ active: dragged }: DragStartEvent) => {
    const item = lanes.flatMap(({ items }) => items).find(({ itemKey }) => itemKey === dragged.id);
    setActive(item ?? null);
  };
  const moveItem = (item: BoardItemView, target: BoardLaneView) => {
    if (target._tag !== "WritableBoardLane" || target.id === laneOf(item.itemKey, lanes)?.id) {
      return;
    }
    setPendingMove({ itemKey: item.itemKey, toLane: target.id });
    move.mutate({ item: item.number, lane: target });
  };
  const onDragEnd = ({ over }: DragEndEvent) => {
    setActive(null);
    if (over === null || active === null) return;
    const target = laneUnder(over.id, lanes);
    if (target !== undefined) moveItem(active, target);
  };
  return (
    <main className="flex flex-col gap-4 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-heading text-xl font-medium wrap-anywhere">{project.repository}</h1>
        {project.status === "needs-you" && <NeedsYouBadge />}
      </header>
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
        onDragEnd={onDragEnd}
        onDragCancel={() => setActive(null)}
      >
        <div
          className="flex gap-3 overflow-x-auto pb-3 overscroll-x-contain scrollbar-thin"
          aria-label={`${project.repository} project board`}
        >
          {lanes.map((lane) => (
            <BoardLane
              key={lane.id}
              lane={lane}
              lanes={lanes}
              catalog={catalog}
              dragging={active !== null}
              pending={pending}
              openRun={openRun}
              onMove={moveItem}
            />
          ))}
        </div>
        <DragOverlay>
          {active !== null && (
            <Card size="sm" className={cn(cardClass(active.needsYou), "cursor-grabbing shadow-lg")}>
              <CardBody item={active} catalog={catalog} openRun={openRun} />
            </Card>
          )}
        </DragOverlay>
      </DndContext>
      {move.isError && <ErrorAlert className="max-w-3xl" message={move.error.message} />}
      {uncarded.length > 0 && <UncardedRuns runs={uncarded} openRun={openRun} />}
    </main>
  );
};
