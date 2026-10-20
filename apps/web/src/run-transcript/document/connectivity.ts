import type { TranscriptEventView } from "@usine/orchestrator/operator";
import { DateTime } from "effect";

/** The Attempt's Worker has not answered the executor's probe since `lastAnsweredAt`. */
interface WorkerSilent {
  readonly _tag: "WorkerSilent";
  readonly worker: string;
  readonly lastAnsweredAt: string;
}

/** A session's harness keeps retrying its model provider; `since` is the first retry without an answer after it. */
interface ProviderRetrying {
  readonly _tag: "ProviderRetrying";
  readonly sessionId: string;
  readonly agent: string;
  readonly message: string;
  readonly retries: number;
  readonly since: string;
}

/** A connectivity problem the Attempt's newest loaded events leave open; a signal, never a stop. */
export type ConnectivityWarning = WorkerSilent | ProviderRetrying;

/**
 * The connectivity problems still open after `events`, one Attempt's in transcript
 * order: the Worker until it answers again, and each session's provider retries
 * until it reaches its provider again, waits for the operator, or finishes.
 */
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
