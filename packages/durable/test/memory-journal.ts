import { ChildSessionBudget, ChildSessionCount } from "@usine/core/agent/session";
import { AttemptId } from "@usine/core/attempt";
import { Deferred, Effect, Option } from "effect";
import { JournalError } from "../src/coordinator/journal.ts";
import type {
  DelegationCall,
  DelegationDetails,
  DelegationJournal,
  DelegationProgress,
  QueuedChildInput,
  ReservedChildReport,
  SavedChild,
} from "../src/attempt/delegation/journal.ts";

/** What a delegation reported to its call about a child's end. */
export type CallReport =
  | { readonly _tag: "Reserved"; readonly sessionId: string; readonly report: ReservedChildReport }
  | { readonly _tag: "Infrastructure"; readonly sessionId: string; readonly message: string }
  | { readonly _tag: "Recovered"; readonly sessionId: string };

/** The Attempt-wide state that a delegation reads and changes. */
export interface MemoryAttempt {
  children: number;
  refused: Option.Option<{ readonly attempted: number; readonly max: number }>;
  held: Array<string>;
  paused: Array<string>;
  queued: Array<QueuedChildInput & { readonly child: string }>;
  reports: Array<CallReport>;
}

/** The saved state of one delegation. */
export interface MemoryDelegation {
  count: Option.Option<number>;
  saved: Option.Option<typeof SavedChild.Encoded>;
  output: string;
  idle: Option.Option<string>;
  idleAnsweredOperator: boolean;
  continuations: Array<number>;
  receipts: Array<string>;
  inFlight: Array<{ readonly callId: string; readonly tool: string }>;
  prompted: boolean;
}

const emptyAttempt = (): MemoryAttempt => ({
  children: 0,
  refused: Option.none(),
  held: [],
  paused: [],
  queued: [],
  reports: [],
});

const emptyDelegation = (): MemoryDelegation => ({
  count: Option.none(),
  saved: Option.none(),
  output: "",
  idle: Option.none(),
  idleAnsweredOperator: false,
  continuations: [],
  receipts: [],
  inFlight: [],
  prompted: true,
});

/**
 * A `DelegationJournal` and its `DelegationCall` that keep one delegation and its Attempt in
 * memory. `start` counts the delegation as the Attempt's next one within `budget`. A journal
 * operation named in `failing` fails with `JournalError`; the others never fail. `release` ends
 * the operator's Hold of a child, and `abort` completes the call's `aborted`.
 */
export const memoryJournal = (
  attempt: MemoryAttempt = emptyAttempt(),
  delegation: MemoryDelegation = emptyDelegation(),
  budget = 3,
) => {
  const failing = new Set<keyof DelegationJournal>();
  const aborted = Deferred.makeUnsafe<void>();
  const guarded =
    (operation: keyof DelegationJournal) =>
    <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E | JournalError> =>
      Effect.suspend((): Effect.Effect<A, E | JournalError> =>
        failing.has(operation)
          ? Effect.fail(
              JournalError.make({
                operation,
                attemptId: AttemptId.make("memory-journal"),
                cause: new Error("The test failed this journal operation"),
              }),
            )
          : effect,
      );
  const running: Array<string> = [];
  const published: Array<DelegationDetails> = [];
  const waiting: Array<{ readonly sessionId: string; readonly ended: Deferred.Deferred<void> }> =
    [];
  const progress = (): DelegationProgress => ({
    output: delegation.output,
    saved: delegation.saved,
    idle: delegation.idle,
    idleAnsweredOperator: delegation.idleAnsweredOperator,
    continuations: [...delegation.continuations],
    receipts: [...delegation.receipts],
    inFlight: [...delegation.inFlight],
    prompted: delegation.prompted,
  });
  const journal: DelegationJournal = {
    start: Effect.sync(() => {
      if (Option.isSome(delegation.count))
        return {
          _tag: "Admitted",
          count: ChildSessionCount.make(delegation.count.value),
          resumed: true,
          progress: progress(),
        } as const;
      const saved = progress();
      attempt.children += 1;
      delegation.count = Option.some(attempt.children);
      const count = ChildSessionCount.make(attempt.children);
      if (attempt.children > budget) {
        if (Option.isNone(attempt.refused))
          attempt.refused = Option.some({ attempted: attempt.children, max: budget });
        return { _tag: "Refused", attempted: count, max: ChildSessionBudget.make(budget) } as const;
      }
      return { _tag: "Admitted", count, resumed: false, progress: saved } as const;
    }).pipe(guarded("start")),
    queuedInputs: (sessionId) =>
      Effect.sync(() => attempt.queued.filter(({ child }) => child === sessionId)).pipe(
        guarded("queuedInputs"),
      ),
    supervision: (sessionId) =>
      Effect.sync(() => ({
        held: attempt.held.includes(sessionId),
        paused: attempt.paused.includes(sessionId),
      })).pipe(guarded("supervision")),
    holdEnded: (sessionId) =>
      Effect.suspend(() => {
        if (!attempt.held.includes(sessionId)) return Effect.void;
        const ended = Deferred.makeUnsafe<void>();
        waiting.push({ sessionId, ended });
        return Deferred.await(ended);
      }).pipe(guarded("holdEnded")),
    releaseSupervision: (sessionId) =>
      Effect.sync(() => {
        attempt.held = attempt.held.filter((id) => id !== sessionId);
        attempt.paused = attempt.paused.filter((id) => id !== sessionId);
      }).pipe(guarded("releaseSupervision")),
    saveSession: (saved, { beforePrompt }) =>
      Effect.sync(() => {
        if (beforePrompt && Option.isNone(delegation.saved)) delegation.prompted = false;
        delegation.saved = Option.some(saved);
      }).pipe(guarded("saveSession")),
    savePrompted: Effect.sync(() => {
      delegation.prompted = true;
    }).pipe(guarded("savePrompted")),
    saveContinuations: (timestamps) =>
      Effect.sync(() => {
        delegation.continuations = [...timestamps];
      }).pipe(guarded("saveContinuations")),
    saveReceipts: (items) =>
      Effect.sync(() => {
        delegation.receipts = [...items];
      }).pipe(guarded("saveReceipts")),
    saveUsage: (usage) =>
      Effect.sync(() => {
        delegation.saved = Option.map(delegation.saved, (saved) => ({ ...saved, usage }));
      }).pipe(guarded("saveUsage")),
    toolStarted: (callId, tool) =>
      Effect.sync(() => {
        delegation.inFlight = [
          ...delegation.inFlight.filter((call) => call.callId !== callId),
          { callId, tool },
        ];
      }).pipe(guarded("toolStarted")),
    toolFinished: (callId) =>
      Effect.sync(() => {
        delegation.inFlight = delegation.inFlight.filter((call) => call.callId !== callId);
      }).pipe(guarded("toolFinished")),
    saveIdle: (report, answeredOperator) =>
      Effect.sync(() => {
        delegation.idle = report;
        delegation.idleAnsweredOperator = answeredOperator;
      }).pipe(guarded("saveIdle")),
    saveOutput: (output) =>
      Effect.sync(() => {
        delegation.output = output;
      }).pipe(guarded("saveOutput")),
  };
  const call: DelegationCall = {
    output: (chunk) =>
      Effect.sync(() => {
        running.push(chunk);
      }),
    retainedOutput: Effect.sync(() => running.join("")),
    publish: (details) =>
      Effect.sync(() => {
        published.push(details);
      }),
    aborted: Deferred.await(aborted),
    infrastructureFailed: (sessionId, message) =>
      Effect.sync(() => {
        attempt.reports.push({ _tag: "Infrastructure", sessionId, message });
      }),
    reserved: (sessionId, report) =>
      Effect.sync(() => {
        attempt.reports.push({ _tag: "Reserved", sessionId, report });
      }),
    recovered: (sessionId) =>
      Effect.sync(() => {
        attempt.reports.push({ _tag: "Recovered", sessionId });
      }),
  };
  const release = (sessionId: string) =>
    Effect.gen(function* () {
      attempt.held = attempt.held.filter((id) => id !== sessionId);
      for (const waiter of waiting.splice(0))
        if (waiter.sessionId === sessionId) yield* Deferred.succeed(waiter.ended, undefined);
        else waiting.push(waiter);
    });
  const abort = Deferred.succeed(aborted, undefined).pipe(Effect.asVoid);
  return { journal, call, attempt, delegation, published, failing, release, abort };
};
