import { canonicalLabelName, GitHubLabelName } from "@usine/config/label";
import {
  isSettledItemState,
  LabelLaneSource,
  Lane,
  type LaneItemState,
  LaneName,
  type LaneSource,
} from "@usine/config/board";
import type { ManagedRepo } from "@usine/config/factory";
import type { Event } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import type { LoopName } from "@usine/core/loop";
import type { RunId } from "@usine/core/run";
import type { ItemProjection } from "@usine/engine/item-projection";
import { ItemLabelMutation } from "@usine/github/item-writer";
import { Effect, Option, Result } from "effect";
import {
  BoardTaskView,
  BoardLaneId,
  BoardProjectionError,
  BoardView,
  ReadOnlyBoardLaneView,
  WritableBoardLaneView,
} from "../operator/board.ts";
import { type RunView } from "../operator/run.ts";
import type { RunUsageView } from "../operator/usage.ts";
import { payloadLabels, projectedItem, type ProjectedItem } from "./items.ts";
import { taskCards } from "./tasks.ts";

interface LaneDefinition {
  readonly lane: Lane;
  readonly origin: "authored" | "proposed";
}

const labelSources = (sources: ReadonlyArray<LaneSource>): ReadonlyArray<GitHubLabelName> =>
  sources.flatMap((source) => ("label" in source ? [source.label] : []));

const stateSources = (sources: ReadonlyArray<LaneSource>): ReadonlyArray<LaneItemState> =>
  sources.flatMap((source) => ("state" in source ? [source.state] : []));

const proposedLanes = (repositoryLabels: ReadonlyArray<string>): ReadonlyArray<LaneDefinition> => {
  const labels = [...repositoryLabels]
    .sort((left, right) => left.localeCompare(right))
    .map((label) => GitHubLabelName.make(label));
  return labels.map((label) => ({
    lane: new Lane({
      name: LaneName.make(label),
      sources: [new LabelLaneSource({ label })],
    }),
    origin: "proposed",
  }));
};

const effectiveLanes = (
  repository: ManagedRepo,
  repositoryLabels: ReadonlyArray<string>,
): ReadonlyArray<LaneDefinition> =>
  repository.lanes.length > 0
    ? repository.lanes.map((lane) => ({ lane, origin: "authored" }))
    : proposedLanes(repositoryLabels);

const laneId = (definition: LaneDefinition): BoardLaneId =>
  BoardLaneId.make(`${definition.origin}:${definition.lane.name}`);

// GitHub matches label names ignoring case, as the label declarations do.
const labelLaneFor = (
  item: Pick<ProjectedItem, "labels">,
  lanes: ReadonlyArray<LaneDefinition>,
): LaneDefinition | undefined => {
  const itemLabels = new Set(item.labels.map(canonicalLabelName));
  return lanes.find(({ lane }) =>
    labelSources(lane.sources).some((label) => itemLabels.has(canonicalLabelName(label))),
  );
};

const stateLaneFor = (
  item: Pick<ProjectedItem, "state" | "labels">,
  lanes: ReadonlyArray<LaneDefinition>,
): LaneDefinition | undefined =>
  lanes.find(({ lane }) => stateSources(lane.sources).includes(item.state));

const laneFor = (
  item: Pick<ProjectedItem, "state" | "labels">,
  lanes: ReadonlyArray<LaneDefinition>,
): LaneDefinition | undefined =>
  isSettledItemState(item.state)
    ? stateLaneFor(item, lanes)
    : (labelLaneFor(item, lanes) ?? stateLaneFor(item, lanes));

/**
 * Returns the lane of a card whose newest open Run is `running`: the label lane that the current
 * Item's labels match, else the label lane that the labels of the Run's Event match. Returns
 * `undefined` if the current Item is closed or merged, or if neither set of labels matches a lane.
 */
const runningLaneFor = Effect.fn("Board.runningLane")(function* (
  repository: ManagedRepo,
  view: BoardTaskView,
  running: RunView,
  lanes: ReadonlyArray<LaneDefinition>,
  runEvents: ReadonlyMap<RunId, Event>,
) {
  const fields = {
    repository: repository.name,
    itemKey: view.itemKey,
    runId: running.id,
    loop: running.loop,
  };
  yield* Effect.annotateCurrentSpan(fields);
  if (isSettledItemState(view.state)) return undefined;
  const current = labelLaneFor(view, lanes);
  if (current !== undefined) {
    yield* Effect.logDebug("Placing the running card in the lane its Item's labels match", {
      ...fields,
      lane: current.lane.name,
    });
    return current;
  }
  const event = runEvents.get(running.id);
  if (event === undefined) {
    yield* Effect.logDebug(
      "No Event read for the card's running Run; placing it by its Item's state",
      fields,
    );
    return undefined;
  }
  const labels = yield* payloadLabels(view.kind, event.payload).pipe(
    Effect.map(Option.some),
    Effect.catch((error) =>
      Effect.logWarning(
        "The running Run's Event has no labels to read; placing its card by its Item's state",
        { ...fields, eventId: event.id, errorTag: error._tag, message: error.message },
      ).pipe(Effect.as(Option.none())),
    ),
  );
  if (Option.isNone(labels)) return undefined;
  const lane = labelLaneFor({ labels: labels.value }, lanes);
  yield* Effect.logDebug(
    lane === undefined
      ? "No lane label when the card's running Run was triggered; placing it by its Item's state"
      : "Keeping the card in the lane its running Run was triggered from",
    { ...fields, lane: lane?.lane.name ?? "none" },
  );
  return lane;
});

/**
 * Groups the repository's stored Items into Task cards and the cards into lanes. A card with a
 * running Run goes to the label lane that its current Item's labels match. If none matches, the
 * card stays in the lane its Run's trigger matched, read from `runEvents`.
 */
export const projectBoard = Effect.fn("Board.project")(
  (
    repository: ManagedRepo,
    repositoryLabels: ReadonlyArray<string>,
    storedItems: ReadonlyArray<ItemProjection>,
    runs: ReadonlyArray<RunView>,
    cycleBlockedItems: ReadonlyArray<ItemKey> = [],
    itemLoops: ReadonlyMap<ItemKey, ReadonlyArray<LoopName>> = new Map(),
    runUsage: ReadonlyMap<RunId, RunUsageView> = new Map(),
    runEvents: ReadonlyMap<RunId, Event> = new Map(),
  ): Effect.Effect<BoardView> =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({ repository: repository.name });
      const results = yield* Effect.forEach(storedItems, (item) =>
        projectedItem(item).pipe(Effect.result),
      );
      const items: Array<ProjectedItem> = [];
      const failures: Array<BoardProjectionError> = [];
      for (const result of results) {
        if (Result.isSuccess(result)) {
          items.push(result.success);
          continue;
        }
        failures.push(result.failure);
        yield* Effect.logError("Item projection quarantined from Board; siblings continue", {
          repository: result.failure.repository,
          itemKey: result.failure.itemKey,
          errorTag: result.failure._tag,
          message: result.failure.message,
        });
      }
      const lanes = effectiveLanes(repository, repositoryLabels);
      const cards = taskCards(repository.name, items, runs, cycleBlockedItems, itemLoops, runUsage);
      yield* Effect.logDebug("Projected Task cards from linked Items", {
        repository: repository.name,
        items: items.length,
        tasks: cards.length,
        runs: runs.length,
        watchedTasks: cards.filter(({ view }) => view.loops.length > 0).length,
        runningTasks: cards.filter(({ running }) => running !== undefined).length,
      });
      const grouped = new Map<BoardLaneId, Array<BoardTaskView>>();
      for (const definition of lanes) grouped.set(laneId(definition), []);
      const unmatched: Array<BoardTaskView> = [];
      for (const { view, running } of cards) {
        const runningLane =
          running === undefined
            ? undefined
            : yield* runningLaneFor(repository, view, running, lanes, runEvents);
        const definition = runningLane ?? laneFor(view, lanes);
        if (definition === undefined) unmatched.push(view);
        else grouped.get(laneId(definition))?.push(view);
      }
      const sortItems = (values: Array<BoardTaskView>) =>
        values.sort((left, right) => right.number - left.number);
      return new BoardView({
        failures,
        lanes: [
          ...lanes.map((definition) => {
            const labels = labelSources(definition.lane.sources);
            const fields = {
              id: laneId(definition),
              name: definition.lane.name,
              sources: definition.lane.sources,
              origin: definition.origin,
              items: sortItems(grouped.get(laneId(definition)) ?? []),
            } as const;
            return definition.origin === "authored" && labels.length > 0
              ? new WritableBoardLaneView({ ...fields, origin: definition.origin, labels })
              : new ReadOnlyBoardLaneView(fields);
          }),
          new ReadOnlyBoardLaneView({
            id: BoardLaneId.make("fallback:unmapped"),
            name: LaneName.make("Unmapped"),
            sources: [],
            origin: "fallback",
            items: sortItems(unmatched),
          }),
        ],
      });
    }),
);

/**
 * Returns labels to add for `target` and labels to remove from the other authored lane sources in
 * `board`. Labels outside the authored lane map are preserved (ADR 0024).
 */
export const labelMutationForBoardMove = (
  board: BoardView,
  target: WritableBoardLaneView,
): ItemLabelMutation => {
  const laneOwned = new Set(
    board.lanes
      .filter(({ origin }) => origin === target.origin)
      .flatMap(({ sources }) => labelSources(sources)),
  );
  const targetLabels = new Set(target.labels);
  return new ItemLabelMutation({
    add: [...targetLabels].sort((left, right) => left.localeCompare(right)),
    remove: [...laneOwned]
      .filter((label) => !targetLabels.has(label))
      .sort((left, right) => left.localeCompare(right)),
  });
};
