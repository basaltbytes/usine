import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { RepositoryName } from "@usine/core/repository";
import type { RunId } from "@usine/core/run";
import type { BoardLaneView, BoardTaskView, StalledItemView } from "@usine/orchestrator/operator";
import { Card } from "~/components/ui/card";
import { CardFace } from "~/features/projects/components/card/face";
import { type CardMoves, CardMenu } from "~/features/projects/components/card/menu";
import { cardClass } from "~/features/projects/lib/styles";
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
  readonly item: BoardTaskView;
  readonly lane: BoardLaneView;
  readonly catalog: LabelCatalog;
  readonly repository: RepositoryName;
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
  item,
  lane,
  catalog,
  draggable,
  phase,
  moves,
  stall,
  readOnly,
  openRun,
  repository,
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
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("group/task relative", isDragging && "opacity-40")}
    >
      <Card
        ref={setActivatorNodeRef}
        size="sm"
        className={cn(
          cardClass(item.needsYou),
          draggable && "touch-none focus-visible:ring-2 focus-visible:ring-ring/70",
        )}
        {...(draggable && attributes)}
        {...(draggable && listeners)}
      >
        <CardFace
          item={item}
          lane={lane}
          catalog={catalog}
          repository={repository}
          stall={stall}
          readOnly={readOnly}
          action={action}
          again={again}
          progress={progressMessage(action, again, phase)}
        />
      </Card>
      <CardMenu
        item={item}
        run={currentRun(item)}
        moves={moves}
        openRun={openRun}
        action={action}
        again={again}
        className="absolute top-1.5 right-1.5 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/task:opacity-100 [@media(hover:hover)]:group-focus-within/task:opacity-100 [@media(hover:hover)]:aria-expanded:opacity-100"
      />
    </div>
  );
};
