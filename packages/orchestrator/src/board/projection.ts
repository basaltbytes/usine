import { canonicalLabelName, GitHubLabelName } from "@usine/config/label";
import {
  LabelLaneSource,
  Lane,
  type LaneItemState,
  LaneName,
  type LaneSource,
} from "@usine/config/board";
import type { ManagedRepo } from "@usine/config/factory";
import { ItemKey } from "@usine/core/item";
import type { ItemProjection } from "@usine/engine/item-projection";
import { ItemLabelMutation } from "@usine/github/item-writer";
import { Effect, Result } from "effect";
import {
  BoardTaskView,
  BoardLaneId,
  BoardProjectionError,
  BoardView,
  ReadOnlyBoardLaneView,
  WritableBoardLaneView,
} from "../operator/board.ts";
import { type RunView } from "../operator/run.ts";
import { projectedItem, type ProjectedItem } from "./items.ts";
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

const SETTLED_STATES: ReadonlyArray<LaneItemState> = ["pr-merged", "pr-closed", "issue-closed"];

const isSettled = (item: Pick<ProjectedItem, "state" | "labels">): boolean =>
  SETTLED_STATES.includes(item.state);

// GitHub matches label names ignoring case, as the label declarations do.
const labelLaneFor = (
  item: Pick<ProjectedItem, "state" | "labels">,
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
  isSettled(item)
    ? stateLaneFor(item, lanes)
    : (labelLaneFor(item, lanes) ?? stateLaneFor(item, lanes));

export const projectBoard = Effect.fn("Board.project")(
  (
    repository: ManagedRepo,
    repositoryLabels: ReadonlyArray<string>,
    storedItems: ReadonlyArray<ItemProjection>,
    runs: ReadonlyArray<RunView>,
    cycleBlockedItems: ReadonlyArray<ItemKey> = [],
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
      const cards = taskCards(repository.name, items, runs, cycleBlockedItems);
      yield* Effect.logDebug("Projected Task cards from linked Items", {
        repository: repository.name,
        items: items.length,
        tasks: cards.length,
        runs: runs.length,
      });
      const grouped = new Map<BoardLaneId, Array<BoardTaskView>>();
      for (const definition of lanes) grouped.set(laneId(definition), []);
      const unmatched: Array<BoardTaskView> = [];
      for (const card of cards) {
        const definition = laneFor(card, lanes);
        if (definition === undefined) unmatched.push(card);
        else grouped.get(laneId(definition))?.push(card);
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
