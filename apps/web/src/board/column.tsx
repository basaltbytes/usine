import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { RunId } from "@usine/core/run";
import type { BoardLaneView, BoardTaskView } from "@usine/orchestrator/operator";
import { LabelBadge } from "@/components/label-badge";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { BoardCard, type LabelCatalog } from "./card.tsx";
import type { BoardMoveProgress } from "./moves.ts";

/** The labels and Item states that route Items to the lane, labels in their GitHub colors. */
const LaneSources = ({
  sources,
  catalog,
}: {
  readonly sources: BoardLaneView["sources"];
  readonly catalog: LabelCatalog;
}) => (
  <ul aria-label="Lane sources" className="flex flex-wrap gap-1">
    {sources.map((source) => (
      <li key={"label" in source ? `label:${source.label}` : `state:${source.state}`}>
        {"label" in source ? (
          <LabelBadge name={source.label} label={catalog.get(source.label)} />
        ) : (
          <Badge variant="outline" className="text-muted-foreground">
            {source.state}
          </Badge>
        )}
      </li>
    ))}
  </ul>
);

/** One lane: its name, count, and sources over a stack of cards, tinted while it is a drag's drop target. */
export const BoardColumn = ({
  lane,
  lanes,
  catalog,
  targeted,
  pending,
  moves,
  openRun,
  onMove,
}: {
  readonly lane: BoardLaneView;
  readonly lanes: ReadonlyArray<BoardLaneView>;
  readonly catalog: LabelCatalog;
  readonly targeted: boolean;
  readonly pending: boolean;
  readonly moves: ReadonlyArray<BoardMoveProgress>;
  readonly openRun: (runId: RunId) => void;
  readonly onMove: (item: BoardTaskView, lane: BoardLaneView) => void;
}) => {
  const writable = lane._tag === "WritableBoardLane";
  const { setNodeRef } = useDroppable({ id: lane.id, disabled: !writable || pending });
  const targets = lanes.filter(
    (other) => other._tag === "WritableBoardLane" && other.id !== lane.id,
  );
  const count = lane.items.length;
  return (
    <section
      ref={setNodeRef}
      aria-label={`${lane.name} lane`}
      className={cn(
        "flex w-72 shrink-0 flex-col gap-3 rounded-lg p-2 transition-colors",
        targeted && "bg-muted/40",
      )}
    >
      <header className="flex flex-col gap-1.5 px-1">
        <h2 className="flex min-w-0 items-baseline gap-2">
          <span className="truncate font-heading text-sm font-medium">{lane.name}</span>
          <span className="text-muted-foreground tabular-nums">{count}</span>
        </h2>
        {lane.sources.length > 0 && <LaneSources sources={lane.sources} catalog={catalog} />}
      </header>
      <div className="flex min-h-40 flex-col gap-2">
        <SortableContext
          items={lane.items.map(({ itemKey }) => itemKey)}
          strategy={verticalListSortingStrategy}
        >
          {count === 0 && <p className="px-1 text-muted-foreground">No tasks</p>}
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
                openRun={openRun}
              />
            );
          })}
        </SortableContext>
      </div>
    </section>
  );
};
