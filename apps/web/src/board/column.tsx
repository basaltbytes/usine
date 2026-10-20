import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { RepositoryName } from "@usine/core/repository";
import type { RunId } from "@usine/core/run";
import type { BoardLaneView, BoardTaskView, StalledItemView } from "@usine/orchestrator/operator";
import { LabelBadge } from "@/components/label-badge";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { BoardCard, type LabelCatalog } from "./card.tsx";
import { FlowArrow, type LaneFlow } from "./flow.tsx";
import type { BoardMoveProgress } from "./moves.ts";

/** The labels and Item states that route Items to the lane, labels in their GitHub colors.
 * `upright` sets them along the narrow column of an empty lane. */
const LaneSources = ({
  sources,
  catalog,
  upright = false,
}: {
  readonly sources: BoardLaneView["sources"];
  readonly catalog: LabelCatalog;
  readonly upright?: boolean;
}) => {
  const chip = upright ? "h-auto w-5 px-0 py-2 [writing-mode:vertical-rl]" : "";
  return (
    <ul
      aria-label="Lane sources"
      className={cn("flex gap-1", upright ? "flex-col items-center" : "flex-wrap")}
    >
      {sources.map((source) => (
        <li
          key={"label" in source ? `label:${source.label}` : `state:${source.state}`}
          className="flex"
        >
          {"label" in source ? (
            <LabelBadge name={source.label} label={catalog.get(source.label)} className={chip} />
          ) : (
            <Badge variant="outline" className={cn("text-muted-foreground", chip)}>
              {source.state}
            </Badge>
          )}
        </li>
      ))}
    </ul>
  );
};

/** A lane with no Task: a narrow dashed column with the lane's count, name, and sources. While a
 * drag is over it, it widens enough to show where the card lands, and it takes the drop like any
 * lane. */
const EmptyLane = ({
  lane,
  catalog,
  targeted,
  setNodeRef,
}: {
  readonly lane: BoardLaneView;
  readonly catalog: LabelCatalog;
  readonly targeted: boolean;
  readonly setNodeRef: (element: HTMLElement | null) => void;
}) => (
  <section
    ref={setNodeRef}
    aria-label={`${lane.name} lane`}
    data-empty-lane=""
    className={cn(
      "flex min-h-40 w-10 shrink-0 justify-center rounded-lg border border-dashed border-input transition-[width,background-color,border-color] duration-(--duration-fast) ease-(--ease-out-expo)",
      targeted && "w-32 border-foreground/25 bg-muted/40",
    )}
  >
    <div className="sticky top-0 flex h-fit flex-col items-center gap-2 pt-1 pb-3">
      <h2 className="flex flex-col-reverse items-center gap-2" title={lane.name}>
        <span className="max-h-60 truncate text-sm font-semibold [writing-mode:vertical-rl]">
          {lane.name}
        </span>{" "}
        <span className="flex h-6 items-center text-sm text-muted-foreground tabular-nums">0</span>
      </h2>
      {lane.sources.length > 0 && <LaneSources sources={lane.sources} catalog={catalog} upright />}
    </div>
  </section>
);

/** One lane: its name, count, and sources over a stack of cards, tinted while it is a drag's drop
 * target. The heading stays in view while the cards scroll under it. An authored label lane
 * followed by another one ends its heading with the flow between them. A lane with no Task
 * collapses to a narrow column. `stallOf` names why a Task is not moving, when the desk says it
 * is not; `readOnly` hides the actions while the factory needs setup. */
export const BoardColumn = ({
  lane,
  lanes,
  flow,
  catalog,
  targeted,
  pending,
  readOnly,
  moves,
  stallOf,
  openRun,
  onMove,
  repository,
}: {
  readonly lane: BoardLaneView;
  readonly lanes: ReadonlyArray<BoardLaneView>;
  readonly flow: LaneFlow | undefined;
  readonly catalog: LabelCatalog;
  readonly targeted: boolean;
  readonly pending: boolean;
  readonly readOnly: boolean;
  readonly moves: ReadonlyArray<BoardMoveProgress>;
  readonly stallOf: (task: BoardTaskView) => StalledItemView | null;
  readonly openRun: (runId: RunId) => void;
  readonly onMove: (item: BoardTaskView, lane: BoardLaneView) => void;
  readonly repository: RepositoryName;
}) => {
  const writable = lane._tag === "WritableBoardLane";
  const empty = lane.items.length === 0;
  const { setNodeRef } = useDroppable({
    id: lane.id,
    disabled: !writable || pending,
    // The lanes after a widening empty lane shift right, so every drop target is measured again.
    resizeObserverConfig: { disabled: !empty, updateMeasurementsFor: [] },
  });
  const targets = lanes.filter(
    (other) => other._tag === "WritableBoardLane" && other.id !== lane.id,
  );
  if (empty)
    return <EmptyLane lane={lane} catalog={catalog} targeted={targeted} setNodeRef={setNodeRef} />;
  return (
    <section
      ref={setNodeRef}
      aria-label={`${lane.name} lane`}
      className={cn(
        "flex w-68 shrink-0 flex-col gap-2 rounded-lg transition-[background-color,box-shadow]",
        targeted && "bg-muted/40 ring-6 ring-muted/40",
      )}
    >
      <header
        className={cn(
          "sticky top-0 z-20 -mx-0.5 flex flex-col gap-1.5 px-1 pt-1 pb-1",
          !targeted && "bg-background",
        )}
      >
        <div className="flex h-6 items-center">
          <h2 className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-sm font-semibold">{lane.name}</span>
            <span className="text-sm text-muted-foreground tabular-nums">{lane.items.length}</span>
          </h2>
          {flow !== undefined && <FlowArrow flow={flow} />}
        </div>
        <div className="min-h-5">
          {lane.sources.length > 0 && <LaneSources sources={lane.sources} catalog={catalog} />}
        </div>
      </header>
      <div className="flex min-h-40 flex-col gap-2">
        <SortableContext
          items={lane.items.map(({ itemKey }) => itemKey)}
          strategy={verticalListSortingStrategy}
        >
          {lane.items.map((item) => {
            const phase = moves.find(({ itemKey }) => itemKey === item.itemKey)?.phase;
            const moveDisabled = pending || phase !== undefined;
            return (
              <BoardCard
                key={item.itemKey}
                item={item}
                lane={lane}
                catalog={catalog}
                draggable={!moveDisabled && targets.length > 0}
                phase={phase}
                moves={{ targets, disabled: moveDisabled, onMove }}
                stall={stallOf(item)}
                readOnly={readOnly}
                openRun={openRun}
                repository={repository}
              />
            );
          })}
        </SortableContext>
      </div>
    </section>
  );
};
