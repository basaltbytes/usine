import type { LaneItemState } from "@usine/config/board";
import { OPEN_STATE_TAGS } from "@usine/core/run/state";
import type {
  BoardLaneId,
  BoardLaneView,
  BoardTaskView,
  RunView,
} from "@usine/orchestrator/operator";
import { Toggle } from "@/components/ui/toggle";

const CLOSED_STATES = new Set<LaneItemState>(["issue-closed", "pr-closed", "pr-merged"]);

const OPEN_STATES = new Set<RunView["state"]>(OPEN_STATE_TAGS);

/** Whether a lane leaves the lane row for a toggle in the Board header: the fallback lane of
 * unrouted Items (Unmapped), and each lane that holds only closed Items (Done). Neither holds
 * work in flight. */
export const isFilterLane = (lane: BoardLaneView): boolean =>
  lane.origin === "fallback" ||
  (lane.sources.length > 0 &&
    lane.sources.every((source) => "state" in source && CLOSED_STATES.has(source.state)));

/** The labels of the authored lanes, in GitHub's case-insensitive form. */
export const authoredLaneLabels = (lanes: ReadonlyArray<BoardLaneView>): ReadonlySet<string> =>
  new Set(
    lanes.flatMap(({ origin, sources }) =>
      origin === "authored"
        ? sources.flatMap((source) => ("label" in source ? [source.label.toLowerCase()] : []))
        : [],
    ),
  );

/**
 * Whether a Task stays on the Board while Show all Items is off. A Task stays when a Loop's
 * trigger matches one of its Items now (the orchestrator evaluates each Loop's trigger against
 * the Item's current payload, as the poll does), when its current Item carries a label an
 * authored lane uses, when one of its Runs is open, or when it needs the operator. Anything else
 * is an Item no Loop can act on as it is, such as a dependabot pull request when every Loop
 * selects by labels it never carries.
 */
export const canMatch = (task: BoardTaskView, laneLabels: ReadonlySet<string>): boolean =>
  task.loops.length > 0 ||
  task.labels.some((label) => laneLabels.has(label.toLowerCase())) ||
  task.runs.some(({ state }) => OPEN_STATES.has(state)) ||
  task.needsYou;

const FilterToggle = ({
  pressed,
  onPressedChange,
  label,
  count,
}: {
  readonly pressed: boolean;
  readonly onPressedChange: (pressed: boolean) => void;
  readonly label: string;
  readonly count?: number;
}) => (
  <Toggle
    variant="outline"
    pressed={pressed}
    onPressedChange={onPressedChange}
    className="gap-1.5 text-sm font-normal aria-pressed:border-ring/40 aria-pressed:bg-secondary aria-pressed:text-foreground"
  >
    {label}
    {count !== undefined && (
      <>
        {" "}
        <span className="text-muted-foreground tabular-nums">{count}</span>
      </>
    )}
  </Toggle>
);

/** The Board header's filters: Show all Items while it hides Tasks or is on, then one toggle per
 * filter lane that holds Tasks or is shown, with its count. */
export const BoardFilters = ({
  lanes,
  shown,
  onShownChange,
  showAll,
  onShowAllChange,
  hidden,
}: {
  /** The filter lanes, such as Done and Unmapped. */
  readonly lanes: ReadonlyArray<BoardLaneView>;
  readonly shown: ReadonlySet<BoardLaneId>;
  readonly onShownChange: (lane: BoardLaneId, shown: boolean) => void;
  readonly showAll: boolean;
  readonly onShowAllChange: (showAll: boolean) => void;
  /** How many Tasks Show all Items would bring back. */
  readonly hidden: number;
}) => (
  <div role="group" aria-label="Board filters" className="flex flex-wrap items-center gap-1.5">
    {(showAll || hidden > 0) && (
      <FilterToggle pressed={showAll} onPressedChange={onShowAllChange} label="Show all Items" />
    )}
    {lanes
      .filter((lane) => lane.items.length > 0 || shown.has(lane.id))
      .map((lane) => (
        <FilterToggle
          key={lane.id}
          pressed={shown.has(lane.id)}
          onPressedChange={(pressed) => onShownChange(lane.id, pressed)}
          label={lane.name}
          count={lane.items.length}
        />
      ))}
  </div>
);
