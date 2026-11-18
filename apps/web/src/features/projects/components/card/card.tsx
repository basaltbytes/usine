import type { ProjectId } from "@usine/core/project";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { RunId } from "@usine/core/run";
import type { BoardLaneView, BoardTaskView, StalledItemView } from "@usine/orchestrator/operator";
import { CardFace } from "~/features/projects/components/card/face";
import { CardFrame } from "~/features/projects/components/card/frame";
import { type CardMoves, CardMenu } from "~/features/projects/components/card/menu";
import type { BoardMoveProgress } from "~/hooks/projects/moves";
import { type CardRunAgain, useCardRunAgain } from "~/hooks/projects/run-again";
import { type RunActions, useRunAction } from "~/hooks/runs/actions";
import { currentRun, type LabelCatalog } from "~/lib/projects/card";
import { moveProgressMessage } from "~/lib/projects/strings";
import { runActionProgress, runAgainProgress } from "~/lib/runs/strings";
import { cn } from "~/lib/utils";

/** Returns the progress text of a pending Run action, Run again, or move, or `null`. */
const progressMessage = (
  action: RunActions,
  again: CardRunAgain,
  phase: BoardMoveProgress["phase"] | undefined,
): string | null => {
  if (action.isPending && action.variables !== undefined)
    return runActionProgress[action.variables.request.action];
  if (again.isPending) return runAgainProgress;
  return phase === undefined ? null : moveProgressMessage(phase);
};

type BoardCardProps = {
  readonly project?: ProjectId | undefined;
  readonly showRepository?: boolean | undefined;
  readonly item: BoardTaskView;
  readonly lane: BoardLaneView;
  readonly catalog: LabelCatalog;
  readonly draggable: boolean;
  readonly phase: BoardMoveProgress["phase"] | undefined;
  readonly moves: CardMoves;
  /** The desk's stall entry for the Task, or `null` if it is not stalled. */
  readonly stall: StalledItemView | null;
  /** Whether to hide the stall's action, as during setup. */
  readonly readOnly: boolean;
  readonly openRun: (runId: RunId) => void;
};

export const BoardCard = ({
  project,
  showRepository,
  item,
  lane,
  catalog,
  draggable,
  phase,
  moves,
  stall,
  readOnly,
  openRun,
}: BoardCardProps) => {
  const action = useRunAction();
  const again = useCardRunAgain(item.itemKey, openRun);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: item.itemKey,
    disabled: { draggable: !draggable, droppable: lane._tag !== "WritableBoardLane" },
  });
  // The menu is next to the drag activator, not inside it, so pressing it does not start a drag.
  return (
    <div
      ref={setNodeRef}
      // oxlint-disable-next-line shadcn/no-inline-styles -- dnd-kit computes the drag offset and transition.
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("group/task group/actions relative", isDragging && "opacity-40")}
    >
      <CardFrame
        ref={setActivatorNodeRef}
        needsYou={item.needsYou}
        className={cn(draggable && "touch-none")}
        {...(draggable && attributes)}
        {...(draggable && listeners)}
      >
        <CardFace
          project={project}
          showRepository={showRepository}
          item={item}
          lane={lane}
          catalog={catalog}
          stall={stall}
          readOnly={readOnly}
          action={action}
          again={again}
          progress={progressMessage(action, again, phase)}
        />
      </CardFrame>
      <CardMenu
        readOnly={readOnly}
        item={item}
        run={currentRun(item)}
        moves={moves}
        openRun={openRun}
        action={action}
        again={again}
        className="absolute top-1.5 right-1.5"
      />
    </div>
  );
};
