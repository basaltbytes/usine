import type { BoardLaneId, BoardLaneView, RunView } from "@usine/orchestrator/operator";
import { cn } from "@/lib/utils";

/** The Run states that put a Loop at work on a Task. */
const AT_WORK = new Set<RunView["state"]>(["Waiting", "Queued", "Running"]);

/** The connection from an authored label lane to the next one on the Board, and the Loops at work
 * on the Tasks it holds: the Loops of their open Runs, in card order. `running` is true when one of
 * those Runs is `Queued` or `Running` rather than waiting for approval. */
export interface LaneFlow {
  readonly next: BoardLaneView;
  readonly loops: ReadonlyArray<RunView["loop"]>;
  readonly running: boolean;
}

/** The flow out of each authored label lane whose right-hand neighbour is also one, keyed by lane. */
export const laneFlows = (
  lanes: ReadonlyArray<BoardLaneView>,
): ReadonlyMap<BoardLaneId, LaneFlow> =>
  new Map(
    lanes.flatMap((lane, index) => {
      const next = lanes[index + 1];
      if (
        next === undefined ||
        lane._tag !== "WritableBoardLane" ||
        next._tag !== "WritableBoardLane"
      )
        return [];
      const open = lane.items.flatMap(({ runs }) => runs.filter(({ state }) => AT_WORK.has(state)));
      const flow: LaneFlow = {
        next,
        loops: [...new Set(open.map(({ loop }) => loop))],
        running: open.some(({ state }) => state !== "Waiting"),
      };
      return [[lane.id, flow] as const];
    }),
  );

/** An arrow from the end of a lane's heading across the gap to the next lane, named after the Loops
 * at work on the lane's Tasks when there are any. */
export const FlowArrow = ({ flow }: { readonly flow: LaneFlow }) => {
  const named = flow.loops.length > 0;
  const loops = flow.loops.join(", ");
  return (
    <p
      data-slot="flow-arrow"
      className={cn(
        "-mr-3 ml-auto flex min-w-0 items-center gap-1.5 pl-2 text-xs",
        !named ? "text-faint" : flow.running ? "text-run-active" : "text-run-waiting",
      )}
      title={named ? `${loops} at work, flowing to ${flow.next.name}` : undefined}
    >
      <span className="sr-only">Flows to {flow.next.name}</span>
      {named && <span className="truncate">{loops}</span>}
      <svg
        aria-hidden="true"
        viewBox="0 0 22 8"
        className="h-2 w-5.5 shrink-0 fill-none stroke-current"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M0.5 4h18M15.5 1l3 3-3 3" />
      </svg>
    </p>
  );
};
