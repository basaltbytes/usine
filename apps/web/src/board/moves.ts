import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ItemKey, ItemNumber } from "@usine/core/item";
import { RepositoryName, splitRepositoryName } from "@usine/core/repository";
import type { BoardLaneView, BoardTaskView, ProjectView } from "@usine/orchestrator/operator";
import { useEffect } from "react";
import { api } from "../api.ts";
import { overviewQuery } from "../overview.ts";

/** A card whose label write is still being saved or observed on the Board. */
export interface BoardMoveProgress {
  readonly itemKey: ItemKey;
  readonly toLane: BoardLaneView["id"];
  readonly phase: "saving" | "syncing";
}

interface TrackedMove extends BoardMoveProgress {
  readonly source: Pick<BoardTaskView, "state" | "labels">;
  readonly laneLabels: ReadonlyArray<BoardTaskView["labels"][number]>;
}

const moveKey = (repository: RepositoryName) => ["board-moves", repository] as const;

// A newer routing change may already have advanced past the drop destination.
// Unrelated label changes and Run updates must not undo the accepted move.
const stillSyncing = (move: TrackedMove, lanes: ReadonlyArray<BoardLaneView>): boolean => {
  if (move.phase === "saving") return true;
  const current = lanes
    .flatMap(({ items }) => items)
    .find(({ itemKey }) => itemKey === move.itemKey);
  if (current === undefined || current.state !== move.source.state) return false;
  const labels = current.labels.filter((label) => move.laneLabels.includes(label));
  return (
    labels.length === move.source.labels.length &&
    labels.every((label) => move.source.labels.includes(label))
  );
};

/** Keeps a Project's accepted moves visible until authoritative routing state changes. */
export const useBoardMoves = (project: ProjectView) => {
  const queryClient = useQueryClient();
  // The query cache outlives routes. A GitHub backoff must not discard an
  // accepted move merely because its Project is closed and opened again.
  const { data: pendingMoves = [] } = useQuery<ReadonlyArray<TrackedMove>>({
    queryKey: moveKey(project.repository),
    queryFn: skipToken,
    initialData: [],
    gcTime: Infinity,
  });
  const updateMoves = (
    repository: RepositoryName,
    update: (moves: ReadonlyArray<TrackedMove>) => ReadonlyArray<TrackedMove>,
  ) =>
    queryClient.setQueryData<ReadonlyArray<TrackedMove>>(moveKey(repository), (current = []) =>
      update(current),
    );
  const moves: ReadonlyArray<BoardMoveProgress> = pendingMoves.filter((move) =>
    stillSyncing(move, project.board.lanes),
  );
  // A first move has no open Run yet, so the overview's idle cadence would
  // otherwise delay both confirmation and the approval prompt after the Hint.
  useQuery({ ...overviewQuery(), enabled: moves.length > 0, refetchInterval: 1_000 });
  useEffect(() => {
    queryClient.setQueryData<ReadonlyArray<TrackedMove>>(moveKey(project.repository), (current) => {
      const remaining = current?.filter((move) => stillSyncing(move, project.board.lanes));
      return remaining?.length === current?.length ? current : remaining;
    });
  }, [queryClient, project.repository, project.board.lanes, pendingMoves]);

  const write = useMutation({
    mutationFn: ({
      repository,
      item,
      toLane,
    }: {
      readonly repository: RepositoryName;
      readonly itemKey: ItemKey;
      readonly item: ItemNumber;
      readonly toLane: BoardLaneView["id"];
    }) => {
      const { owner, name } = splitRepositoryName(repository);
      return api((client) =>
        client.moveBoardItem({
          params: { owner, repository: name, item },
          payload: { toLane },
        }),
      );
    },
    // Bind callbacks to the request's repository: route navigation can replace
    // the observer's current options while the request is still in flight.
    onSuccess: (_, { repository, itemKey }) => {
      updateMoves(repository, (moves) =>
        moves.map((move) => (move.itemKey === itemKey ? { ...move, phase: "syncing" } : move)),
      );
      return queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: (_, { repository, itemKey }) => {
      updateMoves(repository, (moves) => moves.filter((move) => move.itemKey !== itemKey));
      return queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
  });

  const moveItem = (item: BoardTaskView, target: BoardLaneView) => {
    const sourceLane = project.board.lanes.find(({ items }) =>
      items.some(({ itemKey }) => itemKey === item.itemKey),
    );
    const source = sourceLane?.items.find(({ itemKey }) => itemKey === item.itemKey);
    if (
      target._tag !== "WritableBoardLane" ||
      source === undefined ||
      sourceLane?.id === target.id ||
      moves.some(({ itemKey }) => itemKey === item.itemKey)
    )
      return;
    const laneLabels = project.board.lanes.flatMap((lane) =>
      lane._tag === "WritableBoardLane" ? lane.labels : [],
    );
    updateMoves(project.repository, (moves) => [
      ...moves,
      {
        itemKey: item.itemKey,
        toLane: target.id,
        source: {
          state: source.state,
          labels: source.labels.filter((label) => laneLabels.includes(label)),
        },
        laneLabels,
        phase: "saving",
      },
    ]);
    write.mutate({
      repository: project.repository,
      itemKey: item.itemKey,
      item: item.number,
      toLane: target.id,
    });
  };
  const belongsToProject = write.variables?.repository === project.repository;
  return {
    moves,
    moveItem,
    isPending: belongsToProject && write.isPending,
    error: belongsToProject ? write.error : null,
  };
};
