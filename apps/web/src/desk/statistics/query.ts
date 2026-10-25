import { keepPreviousData } from "@tanstack/react-query";
import type { StatisticsWindow } from "@usine/orchestrator/operator";
import { api } from "../../api.ts";

const STATISTICS_REFRESH_MS = 60_000;

/** Reads the statistics of `window`, keeping the previous window's while the next one loads. */
export const statisticsQuery = (window: StatisticsWindow) => ({
  queryKey: ["statistics", window] as const,
  queryFn: () => api((client) => client.statistics({ query: { window } })),
  refetchInterval: STATISTICS_REFRESH_MS,
  placeholderData: keepPreviousData,
});
