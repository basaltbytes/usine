import {
  type QueryClient,
  type QueryFilters,
  queryOptions,
  skipToken,
} from "@tanstack/react-query";
import { ChangeNotice } from "@usine/orchestrator/operator/http";
import { Schema } from "effect";

export type ConnectionState = "connecting" | "connected" | "disconnected";

export const connectionQuery = () =>
  queryOptions({
    queryKey: ["changes-connection"] as const,
    queryFn: skipToken,
    initialData: (): ConnectionState => "connecting",
    staleTime: Infinity,
    gcTime: Infinity,
  });

const refreshQueries = (client: QueryClient, filters: QueryFilters) =>
  Promise.all(
    client
      .getQueryCache()
      .findAll(filters)
      .map((query) => {
        const refresh = () =>
          client.invalidateQueries(
            { predicate: (candidate) => candidate === query },
            { cancelRefetch: false },
          );
        const pending = query.state.fetchStatus === "fetching" ? query.promise : undefined;
        return pending === undefined ? refresh() : pending.then(refresh, refresh);
      }),
  );

/** Invalidates only projections identified by a decoded notice. */
export const invalidateChanges = (client: QueryClient, notice: ChangeNotice) =>
  refreshQueries(client, {
    predicate: (query) => {
      if (query.meta?.refreshLabel === undefined) return false;
      if (notice.reset) return true;
      return notice.changes.some((target) => query.meta?.changes?.(target) === true);
    },
  });

type ChangeSource = Pick<EventTarget, "addEventListener"> & {
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  close: () => void;
};

/** Opens the app's one subscription and refreshes active reads every minute during disconnection. */
export const connectChanges = (
  client: QueryClient,
  createSource: () => ChangeSource = () => new EventSource("/api/changes"),
) => {
  const source = createSource();
  let fallback: ReturnType<typeof setInterval> | undefined;
  let active = true;
  const scheduleRollover = (): ReturnType<typeof setTimeout> => {
    const now = new Date();
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    return setTimeout(() => {
      void refreshQueries(client, { predicate: (query) => query.meta?.utcDayRollover === true });
      rollover = scheduleRollover();
    }, midnight - now.getTime());
  };
  let rollover = scheduleRollover();
  const state = (value: "connected" | "disconnected") => {
    if (!active) return;
    client.setQueryData(connectionQuery().queryKey, value);
    if (value === "connected") {
      if (fallback !== undefined) clearInterval(fallback);
      fallback = undefined;
    } else if (fallback === undefined) {
      void client.invalidateQueries({ queryKey: ["auth-session"] });
      fallback = setInterval(() => {
        void client.invalidateQueries({
          predicate: (query) => query.isActive() && query.meta?.refreshLabel !== undefined,
        });
      }, 60_000);
    }
  };
  source.onopen = () => state("connected");
  source.onerror = () => state("disconnected");
  source.addEventListener("change", (event) => {
    if (!active || !(event instanceof MessageEvent)) return;
    const notice = Schema.decodeUnknownExit(Schema.fromJsonString(ChangeNotice))(event.data);
    if (notice._tag === "Failure") {
      source.close();
      state("disconnected");
      return;
    }
    void invalidateChanges(client, notice.value);
  });
  // A stream that cannot connect still has the same slow recovery path.
  state("disconnected");
  return () => {
    active = false;
    source.close();
    if (fallback !== undefined) clearInterval(fallback);
    clearTimeout(rollover);
  };
};
