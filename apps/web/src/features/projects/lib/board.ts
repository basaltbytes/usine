import {
  type CollisionDetection,
  type KeyboardCoordinateGetter,
  pointerWithin,
  rectIntersection,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import type { BoardLaneView, ProjectView, RunView } from "@usine/orchestrator/operator";
import { type BoardMoveProgress } from "~/hooks/projects/moves";

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
export const dropCollision: CollisionDetection = (args) => {
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
export const laneKeyboardCoordinates =
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
export const applyMove = (
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
