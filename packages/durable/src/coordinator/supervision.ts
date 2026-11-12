import type { AgentSessionId } from "@usine/core/agent/session";
import type { AttemptId } from "@usine/core/attempt";
import { Effect, Option } from "effect";

import {
  type AttemptJournal,
  type CoordinatorSnapshot,
  type JournalError,
  Supervision,
} from "./journal.ts";

/** The operator's supervision of one Attempt's children, stored in the attempt journal. */
export interface Supervisor {
  /** Reads whether the operator holds or pauses the child. */
  readonly of: (sessionId: AgentSessionId) => Effect.Effect<Supervision, JournalError>;
  /** Stores `supervision`. */
  readonly supervise: (supervision: Supervision) => Effect.Effect<void, JournalError>;
}

/** Returns the stored supervision of `sessionId`, or one that neither holds nor pauses it. */
const supervisionOf = (snapshot: CoordinatorSnapshot, sessionId: AgentSessionId) =>
  Option.getOrElse(
    Option.fromUndefinedOr(snapshot.supervision.find((found) => found.sessionId === sessionId)),
    () => Supervision.make({ sessionId, held: false, paused: false }),
  );

/** Returns the supervisor of Attempt `attemptId`. */
export const supervisorFor = (
  journal: AttemptJournal["Service"],
  attemptId: AttemptId,
): Supervisor => ({
  of: (sessionId) =>
    journal.load(attemptId).pipe(
      Effect.map(
        Option.match({
          onNone: () => Supervision.make({ sessionId, held: false, paused: false }),
          onSome: (snapshot) => supervisionOf(snapshot, sessionId),
        }),
      ),
    ),
  supervise: (supervision) => journal.supervise(attemptId, supervision),
});
