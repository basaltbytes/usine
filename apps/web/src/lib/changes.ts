import { type QueryClient, queryOptions, skipToken } from "@tanstack/react-query";
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

/** Invalidates only projections identified by a decoded notice. */
export const invalidateChanges = (client: QueryClient, notice: ChangeNotice) =>
  client.invalidateQueries({
    predicate: (query) => {
      if (query.meta?.refreshLabel === undefined) return false;
      if (notice.reset) return true;
      return notice.changes.some(({ kind, id }) => {
        const [key, entity] = query.queryKey;
        switch (kind) {
          case "project":
            return (key === "project" && entity === id) || key === "search";
          case "run":
            return (
              (key === "run" && entity === id) ||
              (key === "run-github-changes" && entity === id) ||
              key === "statistics"
            );
          case "attempt":
            return query.meta?.attemptId === id;
          case "item":
            return query.meta?.itemKeys?.includes(id) === true;
          case "worker":
            return key === "desk" || key === "workers" || key === "configuration";
          case "configuration":
            return (
              key === "configuration" ||
              key === "configuration-editor" ||
              key === "upgrade" ||
              key === "overview" ||
              key === "agents" ||
              key === "run" ||
              key === "project" ||
              key === "search"
            );
          case "navigation":
            return (key === "overview" && entity !== "attention") || key === "search";
          case "attention":
            return key === "overview" && entity === "attention";
          case "activity":
            return key === "desk" || key === "statistics";
        }
      });
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
  };
};
