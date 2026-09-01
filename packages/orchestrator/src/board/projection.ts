import {
  GitHubLabelName,
  LabelLaneSource,
  Lane,
  type LaneItemState,
  LaneName,
  type LaneSource,
  type ManagedRepo,
} from "@usine/config";
import { Item, RunState } from "@usine/core";
import type { ItemProjection } from "@usine/engine";
import { IssuePayload, ItemLabelMutation, PullRequestPayload } from "@usine/github";
import { Effect, Result, Schema } from "effect";
import {
  BoardItemView,
  BoardLaneId,
  BoardProjectionError,
  BoardView,
  ReadOnlyBoardLaneView,
  type RunView,
  WritableBoardLaneView,
} from "../operator/model.ts";

interface ProjectedItem {
  readonly itemKey: Item.ItemKey;
  readonly kind: "issue" | "pr";
  readonly number: Item.Number;
  readonly title: string;
  readonly url: string;
  readonly state: LaneItemState;
  readonly labels: ReadonlyArray<GitHubLabelName>;
}

interface LaneDefinition {
  readonly lane: Lane;
  readonly origin: "authored" | "proposed";
}

const labelsFrom = Schema.decodeUnknownEffect(Schema.Array(GitHubLabelName));

const projectionError = (item: ItemProjection, message: string) =>
  new BoardProjectionError({
    repository: item.repository,
    itemKey: item.itemKey,
    message,
  });

const projectedItem = (item: ItemProjection): Effect.Effect<ProjectedItem, BoardProjectionError> =>
  Effect.gen(function* () {
    if (item.source === "issue") {
      const payload = yield* Schema.decodeUnknownEffect(IssuePayload)(item.payload).pipe(
        Effect.mapError((error) => projectionError(item, error.message)),
      );
      return {
        itemKey: item.itemKey,
        kind: "issue",
        number: Item.Number.make(item.number),
        title: payload.title,
        url: payload.url,
        state: payload.state === "OPEN" ? "issue-open" : "issue-closed",
        labels: yield* labelsFrom(payload.labels.nodes.map(({ name }) => name)).pipe(
          Effect.mapError((error) => projectionError(item, error.message)),
        ),
      };
    }
    if (item.source === "pr") {
      const payload = yield* Schema.decodeUnknownEffect(PullRequestPayload)(item.payload).pipe(
        Effect.mapError((error) => projectionError(item, error.message)),
      );
      const state: LaneItemState = payload.merged
        ? "pr-merged"
        : payload.state === "OPEN"
          ? "pr-open"
          : "pr-closed";
      return {
        itemKey: item.itemKey,
        kind: "pr",
        number: Item.Number.make(item.number),
        title: payload.title,
        url: payload.url,
        state,
        labels: yield* labelsFrom(payload.labels.nodes.map(({ name }) => name)).pipe(
          Effect.mapError((error) => projectionError(item, error.message)),
        ),
      };
    }
    return yield* projectionError(item, `Unsupported Item projection source: ${item.source}`);
  });

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

const laneFor = (
  item: ProjectedItem,
  lanes: ReadonlyArray<LaneDefinition>,
): LaneDefinition | undefined =>
  lanes.find(({ lane }) =>
    labelSources(lane.sources).some((label) => item.labels.includes(label)),
  ) ?? lanes.find(({ lane }) => stateSources(lane.sources).includes(item.state));

const isOpenRun = (run: RunView): boolean =>
  RunState.OPEN_STATE_TAGS.some((state) => state === run.state);

export const projectBoard = Effect.fn("Board.project")(
  (
    repository: ManagedRepo,
    repositoryLabels: ReadonlyArray<string>,
    storedItems: ReadonlyArray<ItemProjection>,
    runs: ReadonlyArray<RunView>,
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
      const runsByItem = new Map<Item.ItemKey, RunView>();
      for (const run of runs) {
        const selected = runsByItem.get(run.itemKey);
        if (selected === undefined || (isOpenRun(run) && !isOpenRun(selected))) {
          runsByItem.set(run.itemKey, run);
        }
      }
      const cards = items.map((item) => {
        const run = runsByItem.get(item.itemKey) ?? null;
        return new BoardItemView({
          ...item,
          run,
          needsYou: run?.state === "Waiting" || run?.state === "Failed",
        });
      });
      const grouped = new Map<BoardLaneId, Array<BoardItemView>>();
      for (const definition of lanes) grouped.set(laneId(definition), []);
      const unmatched: Array<BoardItemView> = [];
      for (const card of cards) {
        const definition = laneFor(card, lanes);
        if (definition === undefined) unmatched.push(card);
        else grouped.get(laneId(definition))?.push(card);
      }
      const sortItems = (values: Array<BoardItemView>) =>
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
            return labels.length > 0
              ? new WritableBoardLaneView({ ...fields, labels })
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
  item: BoardItemView,
  target: WritableBoardLaneView,
): ItemLabelMutation => {
  const current = board.lanes.find(({ items }) =>
    items.some(({ itemKey }) => itemKey === item.itemKey),
  );
  const laneOwned = new Set(
    current?.origin === "proposed"
      ? labelSources(current.sources)
      : board.lanes
          .filter(({ origin }) => origin === "authored")
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
