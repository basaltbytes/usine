import type { AgentSessionId } from "@usine/core/agent/session";
import type { AttemptId } from "@usine/core/attempt";
import { Deferred, Effect, Option } from "effect";

import {
  type AttemptJournal,
  type CoordinatorSnapshot,
  type JournalError,
  Supervision,
} from "./journal.ts";

/**
 * The operator's supervision of one Attempt's children, stored in the attempt journal and signaled
 * in this process after each change, so a delegation can wait for its child's Hold to end.
 */
export interface Supervisor {
  /** Reads whether the operator holds or pauses the child. */
  readonly of: (sessionId: AgentSessionId) => Effect.Effect<Supervision, JournalError>;
  /** Stores `supervision` and signals the change. */
  readonly supervise: (supervision: Supervision) => Effect.Effect<void, JournalError>;
  /** Completes when the operator does not hold the child, starting with the current Hold. */
  readonly holdEnded: (sessionId: AgentSessionId) => Effect.Effect<void, JournalError>;
}

/** Returns the stored supervision of `sessionId`, or one that neither holds nor pauses it. */
const supervisionOf = (snapshot: CoordinatorSnapshot, sessionId: AgentSessionId) =>
  Option.getOrElse(
    Option.fromUndefinedOr(snapshot.supervision.find((found) => found.sessionId === sessionId)),
    () => Supervision.make({ sessionId, held: false, paused: false }),
  );

/** Returns the supervisor of Attempt `attemptId`. One process owns the Attempt's journal. */
export const supervisorFor = Effect.fn("Supervisor.make")(function* (
  journal: AttemptJournal["Service"],
  attemptId: AttemptId,
) {
  // Replaced after each change; a waiter reads it before the journal, so it misses no change.
  let changed = yield* Deferred.make<void>();

  const of = (sessionId: AgentSessionId) =>
    journal.load(attemptId).pipe(
      Effect.map(
        Option.match({
          onNone: () => Supervision.make({ sessionId, held: false, paused: false }),
          onSome: (snapshot) => supervisionOf(snapshot, sessionId),
        }),
      ),
    );

  const supervise = (supervision: Supervision) =>
    journal.supervise(attemptId, supervision).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const previous = changed;
          changed = yield* Deferred.make<void>();
          yield* Deferred.succeed(previous, undefined);
        }),
      ),
    );

  const holdEnded = Effect.fn("Supervisor.holdEnded")(function* (sessionId: AgentSessionId) {
    yield* Effect.annotateCurrentSpan({ attemptId, sessionId });
    let logged = false;
    while (true) {
      const next = changed;
      if (!(yield* of(sessionId)).held) return;
      if (!logged) {
        logged = true;
        yield* Effect.logInfo("The child's result waits until the operator releases it", {
          attemptId,
          sessionId,
        });
      }
      yield* Deferred.await(next);
    }
  });

  return { of, supervise, holdEnded } satisfies Supervisor;
});
