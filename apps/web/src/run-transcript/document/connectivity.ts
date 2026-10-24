import type { TranscriptEventView } from "@usine/orchestrator/operator";
import { DateTime } from "effect";

/** A Worker that has not answered the executor's probe since `lastAnsweredAt`. */
interface WorkerSilent {
  readonly _tag: "WorkerSilent";
  readonly worker: string;
  readonly lastAnsweredAt: string;
}

/** A harness that is retrying its model provider; `since` is the time of the first unanswered retry. */
interface ProviderRetrying {
  readonly _tag: "ProviderRetrying";
  readonly sessionId: string;
  readonly agent: string;
  readonly message: string;
  readonly retries: number;
  readonly since: string;
}

/** A connectivity problem still open at the newest loaded event; it does not stop the Attempt. */
export type ConnectivityWarning = WorkerSilent | ProviderRetrying;

/** Returns the connectivity problems still open after `events`, which are one Attempt's events in transcript order. */
export const openConnectivity = (
  events: ReadonlyArray<TranscriptEventView>,
): ReadonlyArray<ConnectivityWarning> => {
  let worker: WorkerSilent | null = null;
  const providers = new Map<string, ProviderRetrying>();
  for (const { payload, receivedAt } of events) {
    if (payload._tag === "WorkerUnresponsive") {
      worker = {
        _tag: "WorkerSilent",
        worker: payload.worker,
        lastAnsweredAt: DateTime.formatIso(payload.lastAnsweredAt),
      };
    } else if (payload._tag === "WorkerResponsive") {
      worker = null;
    } else if (payload._tag === "SessionEvent") {
      const event = payload.event;
      if (event._tag === "ProviderRetrying") {
        providers.set(event.session.id, {
          _tag: "ProviderRetrying",
          sessionId: event.session.id,
          agent: event.session.agent,
          message: event.message,
          retries: event.retries,
          since: providers.get(event.session.id)?.since ?? receivedAt,
        });
      } else if (
        event._tag === "ProviderRecovered" ||
        event._tag === "SessionIdle" ||
        event._tag === "SessionFinished"
      ) {
        providers.delete(event.session.id);
      }
    }
  }
  return [...(worker === null ? [] : [worker]), ...providers.values()];
};
