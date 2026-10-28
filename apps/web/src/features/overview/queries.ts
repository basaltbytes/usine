import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import type { StatisticsWindow } from "@usine/orchestrator/operator";
import { api } from "~/lib/api";

const STATISTICS_REFRESH_MS = 60_000;

/** Reads the tasks done in `window`, keeping the previous window's while the next one loads. */
export const statisticsQuery = (window: StatisticsWindow) =>
  queryOptions({
    queryKey: ["statistics", window] as const,
    queryFn: () => api((client) => client.statistics({ query: { window } })),
    staleTime: STATISTICS_REFRESH_MS,
    refetchInterval: STATISTICS_REFRESH_MS,
    placeholderData: keepPreviousData,
  });

/** Reads the run statistics of `window` for the Details disclosure. */
export const runStatisticsQuery = (window: StatisticsWindow) =>
  queryOptions({
    queryKey: ["statistics", "runs", window] as const,
    queryFn: () => api((client) => client.runStatistics({ query: { window } })),
    staleTime: STATISTICS_REFRESH_MS,
    refetchInterval: STATISTICS_REFRESH_MS,
    placeholderData: keepPreviousData,
  });
