import { changes } from "~/lib/query-changes";
import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import type { StatisticsWindow } from "@usine/orchestrator/operator";
import { api } from "~/lib/api";

import { STATISTICS_REFRESH_MS } from "~/lib/statistics/queries";

/** Reads the run statistics of `window` for the Details disclosure. */
export const runStatisticsQuery = (window: StatisticsWindow) =>
  queryOptions({
    queryKey: ["statistics", "runs", window] as const,
    queryFn: () => api((client) => client.runStatistics({ query: { window } })),
    staleTime: STATISTICS_REFRESH_MS,
    meta: {
      refreshLabel: "Statistics",
      changes: changes.kind("run", "activity"),
      utcDayRollover: true,
    },
    placeholderData: keepPreviousData,
  });
