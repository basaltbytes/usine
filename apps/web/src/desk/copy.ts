import type {
  ConnectivityWarningView,
  DeskView,
  RepositoryPollView,
  WorkerView,
} from "@usine/orchestrator/operator";
import { Match } from "effect";
import { agoLabel, clockLabel } from "../operator-copy.ts";

export const warningLine = (warning: ConnectivityWarningView): string =>
  Match.valueTags(warning, {
    WorkerSilent: ({ worker, lastAnsweredAt }) =>
      `${worker} silent since ${clockLabel(lastAnsweredAt)}`,
    ProviderRetrying: ({ agent, retries, since }) =>
      `${agent}: provider unreachable, ${retries} ${retries === 1 ? "retry" : "retries"} since ${clockLabel(since)}`,
  });

const freeSlots = (workers: ReadonlyArray<WorkerView>): number =>
  workers.reduce(
    (free, { slots: { capacity, leased } }) => free + Math.max(0, capacity - leased),
    0,
  );

export const nothingRunning = (workers: ReadonlyArray<WorkerView>): string => {
  const total = workers.reduce((sum, { slots }) => sum + slots.capacity, 0);
  const free = freeSlots(workers);
  if (total === 0) return "Nothing running";
  return `Nothing running, ${free} of ${total} worker ${total === 1 ? "slot" : "slots"} free`;
};

/** Returns text such as `Last checked 2m ago`, or `null` if there are no repositories. */
export const lastCheckedLabel = (
  polls: ReadonlyArray<RepositoryPollView>,
  now: number,
): string | null => {
  if (polls.length === 0) return null;
  if (polls.every(({ polledAt }) => polledAt === null)) return "Not checked yet";
  const [only] = polls;
  if (polls.length === 1 && only !== undefined && only.polledAt !== null) {
    return `Last checked ${agoLabel(only.polledAt, now)}`;
  }
  return `Last checked ${polls
    .map(
      ({ repository, polledAt }) =>
        `${repository} ${polledAt === null ? "not yet" : agoLabel(polledAt, now)}`,
    )
    .join(", ")}`;
};

/** Returns text such as `2 running, 7 stalled`, or `undefined` if both counts are zero. */
export const deskCounts = (desk: DeskView): string | undefined => {
  const parts = [
    desk.running.length > 0 ? `${desk.running.length} running` : null,
    desk.notMoving.length > 0 ? `${desk.notMoving.length} stalled` : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? undefined : parts.join(", ");
};
