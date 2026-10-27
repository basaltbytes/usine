import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { ArrowsInLineHorizontalIcon } from "@phosphor-icons/react";
import { isSettledItemState } from "@usine/config/board";
import type { RepositoryName } from "@usine/core/repository";
import type { RunId } from "@usine/core/run";
import type { BoardLaneView, BoardTaskView, StalledItemView } from "@usine/orchestrator/operator";
import { useState } from "react";
import { LabelBadge } from "~/components/label-badge";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { useScrollEdges } from "~/hooks/use-scroll-edges";
import { cn } from "~/lib/utils";
import { BoardCard } from "~/features/projects/components/card/card";
import { type LabelCatalog } from "~/lib/projects/card";
import { FlowArrow, type LaneFlow } from "~/features/projects/components/flow";
import type { BoardMoveProgress } from "~/hooks/projects/moves";

/** Returns whether a lane starts folded: true for the fallback lane and for lanes with only closed Items. */
export const foldsByDefault = (lane: BoardLaneView): boolean =>
  lane.origin === "fallback" ||
  (lane.sources.length > 0 &&
    lane.sources.every((source) => "state" in source && isSettledItemState(source.state)));

type LaneSourcesProps = {
  readonly sources: BoardLaneView["sources"];
  readonly catalog: LabelCatalog;
};

const LaneSources = ({ sources, catalog }: LaneSourcesProps) => (
  <ul aria-label="Lane sources" className="flex flex-wrap gap-1">
    {sources.map((source) => (
      <li
        key={"label" in source ? `label:${source.label}` : `state:${source.state}`}
        className="flex"
      >
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

type LaneRailProps = { readonly lane: BoardLaneView; readonly open: () => void };

const LaneRail = ({ lane, open }: LaneRailProps) => (
  <section aria-label={`${lane.name} lane`} className="w-10 shrink-0">
    <button
      type="button"
      aria-expanded={false}
      title={`Open ${lane.name}`}
      onClick={open}
      className="flex h-full min-h-40 w-full items-start justify-center rounded-lg bg-card/60 ring-1 ring-border transition-colors outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/70"
    >
      <span className="sticky top-0 flex flex-col-reverse items-center gap-2 py-3">
        <span className="max-h-60 truncate text-sm font-semibold [writing-mode:vertical-rl]">
          {lane.name}
        </span>{" "}
        <span className="text-sm text-muted-foreground tabular-nums">{lane.items.length}</span>
      </span>
    </button>
  </section>
);

type BoardColumnProps = {
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
};

/** `stallOf` returns a Task's stall reason, if any; `readOnly` hides the actions during setup. */
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
}: BoardColumnProps) => {
  const foldable = foldsByDefault(lane);
  const [folded, setFolded] = useState(foldable);
  const writable = lane._tag === "WritableBoardLane";
  const { setNodeRef } = useDroppable({ id: lane.id, disabled: !writable || pending });
  const targets = lanes.filter(
    (other) => other._tag === "WritableBoardLane" && other.id !== lane.id,
  );
  const count = lane.items.length;
  const [listRef, edges] = useScrollEdges();
  if (foldable && folded) return <LaneRail lane={lane} open={() => setFolded(false)} />;
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
          "z-20 -mx-0.5 flex shrink-0 flex-col gap-1.5 px-1 pt-1 pb-1",
          !targeted && "bg-background",
        )}
      >
        <div className="flex h-6 items-center">
          <h2 className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-sm font-semibold">{lane.name}</span>
            <span className="text-sm text-muted-foreground tabular-nums">{count}</span>
          </h2>
          {flow !== undefined && <FlowArrow flow={flow} />}
          {foldable && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-expanded={true}
              aria-label={`Fold ${lane.name}`}
              title={`Fold ${lane.name}`}
              className="ml-auto text-muted-foreground hover:text-foreground"
              onClick={() => setFolded(true)}
            >
              <ArrowsInLineHorizontalIcon aria-hidden="true" />
            </Button>
          )}
        </div>
        <div className="min-h-5">
          {lane.sources.length > 0 && <LaneSources sources={lane.sources} catalog={catalog} />}
        </div>
      </header>
      {/* Scrolls on its own, so each lane scrolls independently; the faded edges show that more cards
          are above or below. The negative margin keeps card rings and shadows inside the clip. */}
      <div
        ref={listRef}
        aria-label={`${lane.name} cards`}
        tabIndex={edges.above || edges.below ? 0 : undefined}
        className={cn(
          "-mx-1 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-y-contain px-1 pb-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
          edges.above && "mask-t-from-[calc(100%-2.5rem)]",
          edges.below && "mask-b-from-[calc(100%-2.5rem)]",
        )}
      >
        <SortableContext
          items={lane.items.map(({ itemKey }) => itemKey)}
          strategy={verticalListSortingStrategy}
        >
          {count === 0 && (
            <p className="rounded-lg border border-dashed border-input px-3 py-2.5 text-xs text-muted-foreground">
              No tasks
            </p>
          )}
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
