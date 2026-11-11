import { Deferred, Effect, Option } from "effect";
import type {
  ChildBlocker,
  DelegationDetails,
  DelegationJournal,
  DelegationProgress,
  QueuedChildInput,
  SavedChild,
} from "../src/attempt/delegation/journal.ts";

/** The Attempt-wide state that a delegation reads and changes. */
export interface MemoryAttempt {
  children: number;
  blocker: Option.Option<ChildBlocker>;
  refused: Option.Option<{ readonly attempted: number; readonly max: number }>;
  held: Array<string>;
  paused: Array<string>;
  queued: Array<QueuedChildInput & { readonly child: string }>;
}

/** The saved state of one delegation. */
export interface MemoryDelegation {
  count: Option.Option<number>;
  saved: Option.Option<typeof SavedChild.Encoded>;
  output: string;
  idle: Option.Option<string>;
  continuations: Array<number>;
  inFlight: Array<{ readonly callId: string; readonly tool: string }>;
  prompted: boolean;
}

const emptyAttempt = (): MemoryAttempt => ({
  children: 0,
  blocker: Option.none(),
  refused: Option.none(),
  held: [],
  paused: [],
  queued: [],
});

const emptyDelegation = (): MemoryDelegation => ({
  count: Option.none(),
  saved: Option.none(),
  output: "",
  idle: Option.none(),
  continuations: [],
  inFlight: [],
  prompted: true,
});

/**
 * A `DelegationJournal` that keeps one delegation and its Attempt in memory. Operations never fail.
 * `release` ends the operator's Hold of a child.
 */
export const memoryJournal = (
  attempt: MemoryAttempt = emptyAttempt(),
  delegation: MemoryDelegation = emptyDelegation(),
) => {
  const running: Array<string> = [];
  const published: Array<DelegationDetails> = [];
  const waiting: Array<{ readonly sessionId: string; readonly ended: Deferred.Deferred<void> }> =
    [];
  const progress = (): DelegationProgress => ({
    output: delegation.output,
    saved: delegation.saved,
    idle: delegation.idle,
    continuations: [...delegation.continuations],
    inFlight: [...delegation.inFlight],
    prompted: delegation.prompted,
  });
  const journal: DelegationJournal = {
    start: (budget, supersedes) =>
      Effect.sync(() => {
        if (Option.isSome(delegation.count))
          return {
            count: delegation.count.value,
            resumed: true,
            progress: progress(),
            superseded: Option.none(),
          };
        const saved = progress();
        attempt.children += 1;
        delegation.count = Option.some(attempt.children);
        if (attempt.children > budget) {
          if (Option.isNone(attempt.refused))
            attempt.refused = Option.some({ attempted: attempt.children, max: budget });
          return {
            count: attempt.children,
            resumed: false,
            progress: saved,
            superseded: Option.none(),
          };
        }
        const superseded = Option.filter(attempt.blocker, supersedes);
        if (Option.isSome(superseded)) attempt.blocker = Option.none();
        return {
          count: attempt.children,
          resumed: false,
          progress: saved,
          superseded: Option.map(superseded, ({ sessionId }) => sessionId),
        };
      }),
    recordBlocker: (blocker, keeps) =>
      Effect.sync(() => {
        if (Option.exists(attempt.blocker, keeps)) return false;
        attempt.blocker = Option.some(blocker);
        return true;
      }),
    clearBlocker: (accept) =>
      Effect.sync(() => {
        if (!Option.exists(attempt.blocker, accept)) return false;
        attempt.blocker = Option.none();
        return true;
      }),
    queuedInputs: (sessionId) =>
      Effect.sync(() => attempt.queued.filter(({ child }) => child === sessionId)),
    supervision: (sessionId) =>
      Effect.sync(() => ({
        held: attempt.held.includes(sessionId),
        paused: attempt.paused.includes(sessionId),
      })),
    holdEnded: (sessionId) =>
      Effect.suspend(() => {
        if (!attempt.held.includes(sessionId)) return Effect.void;
        const ended = Deferred.makeUnsafe<void>();
        waiting.push({ sessionId, ended });
        return Deferred.await(ended);
      }),
    releaseSupervision: (sessionId) =>
      Effect.sync(() => {
        attempt.held = attempt.held.filter((id) => id !== sessionId);
        attempt.paused = attempt.paused.filter((id) => id !== sessionId);
      }),
    saveSession: (saved, { beforePrompt }) =>
      Effect.sync(() => {
        if (beforePrompt && Option.isNone(delegation.saved)) delegation.prompted = false;
        delegation.saved = Option.some(saved);
      }),
    savePrompted: Effect.sync(() => {
      delegation.prompted = true;
    }),
    saveContinuations: (timestamps) =>
      Effect.sync(() => {
        delegation.continuations = [...timestamps];
      }),
    saveUsage: (usage) =>
      Effect.sync(() => {
        delegation.saved = Option.map(delegation.saved, (saved) => ({ ...saved, usage }));
      }),
    toolStarted: (callId, tool) =>
      Effect.sync(() => {
        delegation.inFlight = [
          ...delegation.inFlight.filter((call) => call.callId !== callId),
          { callId, tool },
        ];
      }),
    toolFinished: (callId) =>
      Effect.sync(() => {
        delegation.inFlight = delegation.inFlight.filter((call) => call.callId !== callId);
      }),
    saveIdle: (report) =>
      Effect.sync(() => {
        delegation.idle = report;
      }),
    output: (chunk) =>
      Effect.sync(() => {
        running.push(chunk);
      }),
    saveOutput: Effect.sync(() => {
      delegation.output = running.join("");
    }),
    retainedOutput: Effect.sync(() => running.join("")),
    publish: (details) =>
      Effect.sync(() => {
        published.push(details);
      }),
    aborted: Effect.never,
  };
  const release = (sessionId: string) =>
    Effect.gen(function* () {
      attempt.held = attempt.held.filter((id) => id !== sessionId);
      for (const waiter of waiting.splice(0))
        if (waiter.sessionId === sessionId) yield* Deferred.succeed(waiter.ended, undefined);
        else waiting.push(waiter);
    });
  return { journal, attempt, delegation, published, release };
};
