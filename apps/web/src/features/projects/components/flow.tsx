import type { BoardLaneId, BoardLaneView, LoopView, RunView } from "@usine/orchestrator/operator";
import { Fragment } from "react";
import { cn } from "~/lib/utils";

/** The Run states in which a Loop counts as working on a Task. */
const AT_WORK = new Set<RunView["state"]>(["Waiting", "Queued", "Running"]);

/** A Loop whose trigger currently matches one of the lane's Tasks. */
interface WatchingLoop {
  readonly name: LoopView["name"];
  readonly paused: boolean;
}

/** The link from an authored label lane to the next lane. `tone` is `active` if a Loop has a Queued
 * or Running Run on the lane's Tasks, `waiting` if all open Runs there wait for approval, else `idle`. */
export interface LaneFlow {
  readonly next: BoardLaneView;
  readonly loops: ReadonlyArray<WatchingLoop>;
  readonly tone: "active" | "waiting" | "idle";
}

/** Returns the flow of each authored label lane whose right neighbor is also an authored label lane. */
export const laneFlows = (
  lanes: ReadonlyArray<BoardLaneView>,
  loops: ReadonlyArray<LoopView>,
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
      const watching = new Set(lane.items.flatMap((task) => task.loops));
      const open = lane.items.flatMap(({ runs }) =>
        runs.filter(({ state, loop }) => AT_WORK.has(state) && watching.has(loop)),
      );
      const flow: LaneFlow = {
        next,
        loops: loops
          .filter(({ name }) => watching.has(name))
          .map(({ name, paused }) => ({ name, paused })),
        tone: open.some(({ state }) => state !== "Waiting")
          ? "active"
          : open.length > 0
            ? "waiting"
            : "idle",
      };
      return [[lane.id, flow] as const];
    }),
  );

const loopsTitle = (loops: ReadonlyArray<WatchingLoop>): string =>
  loops.map(({ name, paused }) => (paused ? `${name} (paused)` : name)).join(", ");

/** Renders an arrow to the next lane, labelled with the matching Loops; if no Loop matches, the arrow has no label. */
export const FlowArrow = ({ flow }: { readonly flow: LaneFlow }) => {
  const named = flow.loops.length > 0;
  return (
    <p
      data-slot="flow-arrow"
      className={cn(
        "-mr-3 ml-auto flex min-w-0 items-center gap-1.5 pl-2 text-xs",
        flow.tone === "active"
          ? "text-run-active"
          : flow.tone === "waiting"
            ? "text-run-waiting"
            : "text-muted-foreground",
      )}
      title={
        named
          ? `Loops matching this lane: ${loopsTitle(flow.loops)}. Flows to ${flow.next.name}`
          : undefined
      }
    >
      <span className="sr-only">Flows to {flow.next.name}</span>
      {named && (
        <span className="truncate">
          {flow.loops.map(({ name, paused }, index) => (
            <Fragment key={name}>
              {index > 0 && ", "}
              {name}
              {paused && <span className="text-muted-foreground"> paused</span>}
            </Fragment>
          ))}
        </span>
      )}
      <svg
        aria-hidden="true"
        viewBox="0 0 22 8"
        className={cn(
          "h-2 w-5.5 shrink-0 fill-none stroke-current",
          flow.tone === "idle" && "text-faint",
        )}
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M0.5 4h18M15.5 1l3 3-3 3" />
      </svg>
    </p>
  );
};
