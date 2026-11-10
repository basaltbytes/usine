import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import type { StatisticsWindow } from "@usine/orchestrator/operator";
import { api } from "~/lib/api";
import { changes } from "~/lib/query-changes";

/** The time statistics stay fresh, in milliseconds. */
export const STATISTICS_REFRESH_MS = 60_000;

/** Reads the tasks done in `window`, keeping the previous window's while the next one loads. */
export const statisticsQuery = (window: StatisticsWindow) =>
  queryOptions({
    queryKey: ["statistics", window] as const,
    queryFn: () => api((client) => client.statistics({ query: { window } })),
    staleTime: STATISTICS_REFRESH_MS,
    meta: {
      refreshLabel: "Statistics",
      changes: changes.kind("run", "activity"),
      utcDayRollover: true,
    },
    placeholderData: keepPreviousData,
  });
