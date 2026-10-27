import { keepPreviousData } from "@tanstack/react-query";
import type { StatisticsWindow } from "@usine/orchestrator/operator";
import { api } from "~/lib/api";

const STATISTICS_REFRESH_MS = 60_000;

/** Reads the tasks done in `window`, keeping the previous window's while the next one loads. */
export const statisticsQuery = (window: StatisticsWindow) => ({
  queryKey: ["statistics", window] as const,
  queryFn: () => api((client) => client.statistics({ query: { window } })),
  refetchInterval: STATISTICS_REFRESH_MS,
  placeholderData: keepPreviousData,
});

/** Reads the run statistics of `window` for the Details disclosure. */
export const runStatisticsQuery = (window: StatisticsWindow) => ({
  queryKey: ["statistics", "runs", window] as const,
  queryFn: () => api((client) => client.runStatistics({ query: { window } })),
  refetchInterval: STATISTICS_REFRESH_MS,
  placeholderData: keepPreviousData,
});
