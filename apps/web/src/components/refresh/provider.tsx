import { useQueryClient } from "@tanstack/react-query";
import { isFunction } from "effect/Predicate";
import { createContext, useEffect, useState, type ReactNode } from "react";

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: { readonly refreshLabel?: string };
  }
}

type RefreshSource = {
  readonly label: string;
  readonly updatedAt: number;
  readonly failedSince: number | null;
};

export const RefreshContext = createContext<ReadonlyArray<RefreshSource>>([]);

type RefreshProviderProps = { readonly children: ReactNode };

/** Tracks successful reads and continuous failures for the page's active polling queries. */
export const RefreshProvider = ({ children }: RefreshProviderProps) => {
  const client = useQueryClient();
  const [sources, setSources] = useState<ReadonlyArray<RefreshSource>>([]);
  useEffect(() => {
    const cache = client.getQueryCache();
    const failures = new Map<string, number>();
    const update = () => {
      const next: RefreshSource[] = [];
      for (const query of cache.getAll()) {
        const label = query.meta?.refreshLabel;
        if (label === undefined) continue;
        if (query.state.status === "success") failures.delete(query.queryHash);
        else if (query.state.status === "error" && !failures.has(query.queryHash))
          failures.set(query.queryHash, query.state.errorUpdatedAt);
        const polling = query.observers.some(({ options }) => {
          const enabled = isFunction(options.enabled) ? options.enabled(query) : options.enabled;
          const interval = isFunction(options.refetchInterval)
            ? options.refetchInterval(query)
            : options.refetchInterval;
          return (
            enabled !== false &&
            interval !== false &&
            interval !== undefined &&
            interval > 0 &&
            Number.isFinite(interval)
          );
        });
        if (polling)
          next.push({
            label,
            updatedAt: query.state.dataUpdatedAt,
            failedSince: failures.get(query.queryHash) ?? null,
          });
      }
      setSources((current) =>
        current.length === next.length &&
        current.every((source, index) => {
          const other = next[index];
          return (
            source.label === other?.label &&
            source.updatedAt === other.updatedAt &&
            source.failedSince === other.failedSince
          );
        })
          ? current
          : next,
      );
    };
    const unsubscribe = cache.subscribe((event) => {
      if (event.type === "removed") failures.delete(event.query.queryHash);
      update();
    });
    update();
    return unsubscribe;
  }, [client]);
  return <RefreshContext value={sources}>{children}</RefreshContext>;
};
