import { connectionQuery, type ConnectionState } from "~/lib/changes";
import { notifyManager, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useEffect, useState, type ReactNode } from "react";

type RefreshSource = {
  readonly label: string;
  readonly updatedAt: number;
  readonly failedSince: number | null;
};

export const RefreshContext = createContext<{
  readonly sources: ReadonlyArray<RefreshSource>;
  readonly connection: ConnectionState;
}>({ sources: [], connection: "connecting" });

type RefreshProviderProps = { readonly children: ReactNode };

/** Tracks successful reads and continuous failures for the page's active queries. */
export const RefreshProvider = ({ children }: RefreshProviderProps) => {
  const client = useQueryClient();
  const { data: connection = "connecting" } = useQuery(connectionQuery());
  const [sources, setSources] = useState<ReadonlyArray<RefreshSource>>([]);
  useEffect(() => {
    const cache = client.getQueryCache();
    const failures = new Map<string, number>();
    let active = true;
    const update = () => {
      const next: RefreshSource[] = [];
      for (const query of cache.getAll()) {
        const label = query.meta?.refreshLabel;
        if (label === undefined) continue;
        if (query.state.status === "success") failures.delete(query.queryHash);
        else if (query.state.status === "error" && !failures.has(query.queryHash))
          failures.set(query.queryHash, query.state.errorUpdatedAt);
        if (query.isActive())
          next.push({
            label,
            updatedAt: query.state.dataUpdatedAt,
            failedSince: failures.get(query.queryHash) ?? null,
          });
      }
      notifyManager.schedule(() => {
        if (!active) return;
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
      });
    };
    const unsubscribe = cache.subscribe((event) => {
      if (event.type === "removed") failures.delete(event.query.queryHash);
      update();
    });
    update();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [client]);
  return <RefreshContext value={{ sources, connection }}>{children}</RefreshContext>;
};
