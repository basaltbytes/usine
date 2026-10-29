import type { ProjectId } from "@usine/core/project";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ItemKey, ItemNumber } from "@usine/core/item";
import { RepositoryName, splitRepositoryName } from "@usine/core/repository";
import type { BoardLaneView, BoardTaskView, ProjectView } from "@usine/orchestrator/operator";
import { useEffect } from "react";
import { api } from "~/lib/api";
import { projectId, overviewQuery } from "~/lib/overview";

/** A card whose label change is still saving or not yet shown on the Board. */
export interface BoardMoveProgress {
  readonly itemKey: ItemKey;
  readonly toLane: BoardLaneView["id"];
  readonly phase: "saving" | "syncing";
}

interface TrackedMove extends BoardMoveProgress {
  readonly source: Pick<BoardTaskView, "state" | "labels">;
  readonly laneLabels: ReadonlyArray<BoardTaskView["labels"][number]>;
}

const moveKey = (project: ProjectId) => ["board-moves", project] as const;

// A move ends once the Item's state or lane labels differ from the source, even if they no longer
// match the drop lane; other labels and Run updates are ignored.
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

/** Tracks the Project's accepted moves until the Item's routing state on the Board changes. */
export const useBoardMoves = (project: ProjectView) => {
  const queryClient = useQueryClient();
  // The query cache outlives routes, so moves are kept if the Project reopens during a backoff.
  const { data: pendingMoves = [] } = useQuery<ReadonlyArray<TrackedMove>>({
    queryKey: moveKey(projectId(project)),
    queryFn: skipToken,
    initialData: [],
    gcTime: Infinity,
  });
  const updateMoves = (
    project: ProjectId,
    update: (moves: ReadonlyArray<TrackedMove>) => ReadonlyArray<TrackedMove>,
  ) =>
    queryClient.setQueryData<ReadonlyArray<TrackedMove>>(moveKey(project), (current = []) =>
      update(current),
    );
  const moves: ReadonlyArray<BoardMoveProgress> = pendingMoves.filter((move) =>
    stillSyncing(move, project.board.lanes),
  );
  // A first move has no open Run, so the idle interval would delay confirmation and approval.
  useQuery({ ...overviewQuery(), enabled: moves.length > 0, refetchInterval: 1_000 });
  useEffect(() => {
    queryClient.setQueryData<ReadonlyArray<TrackedMove>>(moveKey(projectId(project)), (current) => {
      const remaining = current?.filter((move) => stillSyncing(move, project.board.lanes));
      return remaining?.length === current?.length ? current : remaining;
    });
  }, [queryClient, project, project.board.lanes, pendingMoves]);

  const write = useMutation({
    mutationFn: ({
      repository,
      item,
      toLane,
    }: {
      readonly repository: RepositoryName;
      readonly boardProject: ProjectId;
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
    // Callbacks use the request's board because navigation can replace the observer's options
    // while the request is in flight.
    onSuccess: (_, { boardProject, itemKey }) => {
      updateMoves(boardProject, (moves) =>
        moves.map((move) => (move.itemKey === itemKey ? { ...move, phase: "syncing" } : move)),
      );
      return queryClient.invalidateQueries({ queryKey: overviewQuery().queryKey });
    },
    onError: (_, { boardProject, itemKey }) => {
      updateMoves(boardProject, (moves) => moves.filter((move) => move.itemKey !== itemKey));
      return queryClient.invalidateQueries({ queryKey: overviewQuery().queryKey });
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
    updateMoves(projectId(project), (moves) => [
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
      repository: item.repository,
      boardProject: projectId(project),
      itemKey: item.itemKey,
      item: item.number,
      toLane: target.id,
    });
  };
  const belongsToProject = write.variables?.boardProject === projectId(project);
  return {
    moves,
    moveItem,
    isPending: belongsToProject && write.isPending,
    error: belongsToProject ? write.error : null,
  };
};
