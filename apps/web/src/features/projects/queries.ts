import {
  infiniteQueryOptions,
  keepPreviousData,
  queryOptions,
  type InfiniteData,
} from "@tanstack/react-query";
import type { ProjectId } from "@usine/core/project";
import type { BoardLaneId, BoardTaskView } from "@usine/orchestrator/operator";
import { api } from "~/lib/api";

export const projectQuery = (project: ProjectId) =>
  queryOptions({
    queryKey: ["project", project, "board"] as const,
    queryFn: () => api((client) => client.project({ params: { project } }), "board"),
    staleTime: 30_000,
    meta: { refreshLabel: "Board", projectId: project },
  });

export const laneItemsQuery = (project: ProjectId, lane: BoardLaneId) =>
  infiniteQueryOptions({
    queryKey: ["project", project, "lane", lane] as const,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api((client) =>
        client.boardLaneItems({ params: { project, lane }, query: { offset: pageParam } }),
      ),
    getNextPageParam: (page) => page.nextOffset ?? undefined,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    meta: { refreshLabel: "Board", projectId: project },
  });

/** Subscribes to pages loaded by a column without fetching folded lanes. */
export const loadedLaneItemsQuery = (project: ProjectId, lane: BoardLaneId) =>
  queryOptions({
    queryKey: laneItemsQuery(project, lane).queryKey,
    enabled: false,
    meta: { refreshLabel: "Board", projectId: project },
    select: (data: InfiniteData<{ readonly items: ReadonlyArray<BoardTaskView> }>) =>
      data.pages.flatMap(({ items }) => items),
  });
