import type { Query } from "@tanstack/react-query";
import type { DeskView } from "@usine/orchestrator/operator";
import { api } from "~/lib/api";

const BUSY_DESK_REFRESH_MS = 3_000;
const IDLE_DESK_REFRESH_MS = 15_000;

export const deskQuery = () => ({
  queryKey: ["desk"] as const,
  queryFn: () => api((client) => client.desk()),
  refetchInterval: (query: Query<DeskView, Error, DeskView, readonly ["desk"]>) => {
    const desk = query.state.data;
    const busy =
      desk !== undefined &&
      (desk.running.length > 0 ||
        desk.notMoving.some(({ reason }) => reason._tag === "QueuedForWorker"));
    return busy ? BUSY_DESK_REFRESH_MS : IDLE_DESK_REFRESH_MS;
  },
});
