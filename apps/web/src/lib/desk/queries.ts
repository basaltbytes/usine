import { queryOptions } from "@tanstack/react-query";
import { api } from "~/lib/api";

const BUSY_DESK_REFRESH_MS = 3_000;
const IDLE_DESK_REFRESH_MS = 15_000;

export const deskQuery = () =>
  queryOptions({
    queryKey: ["desk"] as const,
    queryFn: () => api((client) => client.desk()),
    meta: { refreshLabel: "Activity" },
    refetchInterval: (query) => {
      const desk = query.state.data;
      const busy =
        desk !== undefined &&
        (desk.running.length > 0 ||
          desk.notMoving.some(
            ({ reason }) =>
              reason._tag === "QueuedForWorker" || reason._tag === "WaitingForUpgrade",
          ));
      return busy ? BUSY_DESK_REFRESH_MS : IDLE_DESK_REFRESH_MS;
    },
  });
