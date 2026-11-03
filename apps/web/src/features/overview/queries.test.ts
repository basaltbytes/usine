import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { connectChanges } from "~/lib/changes";
import { runStatisticsQuery, statisticsQuery } from "./queries";

class Source extends EventTarget {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  close = () => {};
}

it.each(["7d", "30d", "all"] as const)(
  "refreshes %s task and run statistics at each UTC midnight while connected",
  async (window) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-03T18:59:59-05:00"));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const source = new Source();
    const disconnect = connectChanges(client, () => source);
    source.onopen?.(new Event("open"));
    const observers = [statisticsQuery(window), runStatisticsQuery(window)].map(
      ({ queryKey }) =>
        new QueryObserver(client, {
          queryKey,
          staleTime: Infinity,
          queryFn: async () => new Date().toISOString().slice(0, 10),
        }),
    );
    const unsubscribe = observers.map((observer) => observer.subscribe(() => {}));
    const boardKey = ["project", "one"];
    client.setQueryData(boardKey, "unchanged");
    try {
      await vi.advanceTimersByTimeAsync(0);
      for (const observer of observers) expect(observer.getCurrentResult().data).toBe("2026-11-03");
      await vi.advanceTimersByTimeAsync(999);
      for (const observer of observers) expect(observer.getCurrentResult().data).toBe("2026-11-03");
      await vi.advanceTimersByTimeAsync(1);
      for (const observer of observers) expect(observer.getCurrentResult().data).toBe("2026-11-04");
      expect(client.getQueryState(boardKey)?.isInvalidated).toBe(false);

      unsubscribe[1]?.();
      await vi.advanceTimersByTimeAsync(86_399_999);
      expect(observers[0]?.getCurrentResult().dataUpdatedAt).toBe(
        Date.parse("2026-11-04T00:00:00Z"),
      );
      await vi.advanceTimersByTimeAsync(1);
      expect(observers[0]?.getCurrentResult().data).toBe("2026-11-05");
      const details = runStatisticsQuery(window);
      expect(client.getQueryState(details.queryKey)?.isInvalidated).toBe(true);
      expect(client.getQueryData(details.queryKey)).toBe("2026-11-04");

      disconnect();
      await vi.advanceTimersByTimeAsync(86_400_000);
      expect(observers[0]?.getCurrentResult().data).toBe("2026-11-05");
    } finally {
      disconnect();
      for (const stop of unsubscribe) stop();
      client.clear();
      vi.useRealTimers();
    }
  },
);

it("refreshes statistics again when a read started before UTC midnight finishes afterward", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-03T23:59:59.500Z"));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const source = new Source();
  const disconnect = connectChanges(client, () => source);
  source.onopen?.(new Event("open"));
  const { queryKey } = statisticsQuery("7d");
  const observer = new QueryObserver(client, {
    queryKey,
    queryFn: async () => {
      const day = new Date().toISOString().slice(0, 10);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      return day;
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    await vi.advanceTimersByTimeAsync(1_000);
    expect(observer.getCurrentResult().data).toBe("2026-11-03");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(observer.getCurrentResult().data).toBe("2026-11-04");
  } finally {
    disconnect();
    unsubscribe();
    client.clear();
    vi.useRealTimers();
  }
});
