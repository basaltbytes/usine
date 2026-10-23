import { Attempt, AttemptId, AttemptNumber, shouldAutoRetry } from "@usine/core/attempt";
import { AttemptFailure, InfraFailure } from "@usine/core/attempt/failure";
import { AttemptCanceled, AttemptFailed, AttemptSucceeded } from "@usine/core/attempt/outcome";
import type { SalvagePushed } from "@usine/core/attempt/salvage";
import {
  type AttemptStart,
  type OperatorRetryStart,
  StartedAfterRestart,
  StartedByEvent,
  StartedByInfraRetry,
} from "@usine/core/attempt/start";
import { EventId } from "@usine/core/event";
import { Run, RunId } from "@usine/core/run";
import * as RunState from "@usine/core/run/state";
import { StepResult } from "@usine/core/step/result";
import { Array as EffectArray, Option, Result } from "effect";
import type { IgnoreReason } from "./submission.ts";

const MAX_AUTO_ATTEMPTS = AttemptNumber.make(3);

/** A Run and its Attempts, ordered by Attempt number. */
interface RunProgress {
  readonly run: Run;
  readonly attempts: ReadonlyArray<Attempt>;
}

type Unchanged = {
  readonly _tag: "Unchanged";
  readonly reason: "RunNotRunning" | "NoOpenAttempt" | "AttemptReplaced";
};

type RetryAttempt = {
  readonly _tag: "RetryAttempt";
  readonly attempt: Attempt;
  readonly outcome: AttemptFailed;
};

type RunFailed = {
  readonly _tag: "RunFailed";
  readonly attempt: Attempt;
  readonly outcome: AttemptFailed;
  readonly state: RunState.Failed;
};

type RunSucceeded = {
  readonly _tag: "RunSucceeded";
  readonly attempt: Attempt;
  readonly outcome: AttemptSucceeded;
  readonly state: RunState.Succeeded;
  readonly result: StepResult;
};

/** The changes committed together when an Attempt finishes. */
export type FinishDecision = RetryAttempt | RunFailed | RunSucceeded | Unchanged;

const openAttempt = (current: RunProgress): Option.Option<Attempt> =>
  Option.fromNullishOr(current.attempts.at(-1)).pipe(
    Option.filter((attempt) => Option.isNone(attempt.outcome)),
  );

const failRunningAttempt = (
  state: RunState.Running,
  attempt: Attempt,
  failure: AttemptFailure,
): RetryAttempt | RunFailed => {
  const outcome = new AttemptFailed({ failure });
  if (shouldAutoRetry({ failure, number: attempt.number, maxAutoAttempts: MAX_AUTO_ATTEMPTS })) {
    return { _tag: "RetryAttempt", attempt, outcome };
  }
  return { _tag: "RunFailed", attempt, outcome, state: RunState.fail(state) };
};

/**
 * Returns the changes for the executor result of `attemptId`. An infrastructure failure is
 * retried up to 3 Attempts in total; a late or repeated result returns `Unchanged`.
 */
export const finishAttempt = (
  current: RunProgress,
  attemptId: AttemptId,
  result: Result.Result<StepResult, AttemptFailure>,
): FinishDecision => {
  if (current.run.state._tag !== "Running") {
    return { _tag: "Unchanged", reason: "RunNotRunning" };
  }
  const attempt = openAttempt(current);
  if (Option.isNone(attempt)) return { _tag: "Unchanged", reason: "NoOpenAttempt" };
  // A result from before a restart or retry doesn't apply to the replacement Attempt.
  if (attempt.value.id !== attemptId) return { _tag: "Unchanged", reason: "AttemptReplaced" };
  if (Result.isFailure(result)) {
    return failRunningAttempt(current.run.state, attempt.value, result.failure);
  }
  return {
    _tag: "RunSucceeded",
    attempt: attempt.value,
    outcome: new AttemptSucceeded(),
    state: RunState.succeed(current.run.state),
    result: result.success,
  };
};

type StartDecision =
  | {
      readonly _tag: "StartAttempt";
      readonly state: RunState.Running;
      readonly number: AttemptNumber;
      readonly start: AttemptStart;
      readonly interrupted: Option.Option<RetryAttempt>;
      readonly resume: Option.Option<SalvagePushed>;
    }
  | {
      readonly _tag: "ReattachAttempt";
      readonly state: RunState.Running;
      readonly attempt: Attempt;
      readonly resume: Option.Option<SalvagePushed>;
    }
  | RunFailed
  | { readonly _tag: "RunClosed"; readonly state: RunState.RunState };

// Only a pushed salvage can be fetched on another Worker, so a retry resumes from the newest one.
const newestPushedSalvage = (attempts: ReadonlyArray<Attempt>): Option.Option<SalvagePushed> =>
  EffectArray.findLast(attempts, (attempt) =>
    Option.filter(
      attempt.salvage,
      (salvage): salvage is SalvagePushed => salvage._tag === "Pushed",
    ),
  );

/**
 * Returns how the next Attempt starts after a Worker reservation. If an open Attempt's parent
 * task is `live`, reattaches it without using a retry; otherwise fails it with `interruption`,
 * counted against the retry cap. `requested` is the operator retry that reopened the Run, if any.
 */
export const beginAttempt = (
  current: RunProgress,
  interruption: InfraFailure,
  live: Option.Option<AttemptId>,
  requested: Option.Option<OperatorRetryStart>,
): StartDecision => {
  const state = current.run.state;
  if (!RunState.isStartable(state) && state._tag !== "Running") {
    return { _tag: "RunClosed", state };
  }
  let interrupted = Option.none<RetryAttempt>();
  const attempt = openAttempt(current);
  if (state._tag === "Running" && Option.isSome(attempt)) {
    if (Option.contains(live, attempt.value.id)) {
      return {
        _tag: "ReattachAttempt",
        state,
        attempt: attempt.value,
        resume: newestPushedSalvage(current.attempts),
      };
    }
    const recovery = failRunningAttempt(state, attempt.value, interruption);
    if (recovery._tag === "RunFailed") return recovery;
    interrupted = Option.some(recovery);
  }
  const start: AttemptStart = Option.isSome(interrupted)
    ? new StartedAfterRestart()
    : Option.getOrElse(requested, (): AttemptStart =>
        current.attempts.length === 0 ? new StartedByEvent() : new StartedByInfraRetry(),
      );
  return {
    _tag: "StartAttempt",
    state: state._tag === "Running" ? state : RunState.start(state),
    number: AttemptNumber.make((current.attempts.at(-1)?.number ?? 0) + 1),
    start,
    interrupted,
    resume: newestPushedSalvage(current.attempts),
  };
};

type CancelDecision =
  | { readonly _tag: "AlreadyClosed" }
  | {
      readonly _tag: "Canceled";
      readonly state: RunState.Canceled;
      readonly attempt: Option.Option<{
        readonly id: AttemptId;
        readonly outcome: AttemptCanceled;
      }>;
    };

/** Returns the cancel decision for an open Run and its open Attempt, if any. */
export const cancelRun = (current: RunProgress): CancelDecision => {
  if (!RunState.isOpen(current.run.state)) return { _tag: "AlreadyClosed" };
  return {
    _tag: "Canceled",
    state: RunState.cancelByOperator(current.run.state),
    attempt:
      current.run.state._tag === "Running"
        ? Option.map(openAttempt(current), (attempt) => ({
            id: attempt.id,
            outcome: new AttemptCanceled(),
          }))
        : Option.none(),
  };
};

type RetryDecision =
  | { readonly _tag: "Resume"; readonly state: RunState.Running }
  | { readonly _tag: "ResumePending" }
  | { readonly _tag: "RetryRejected" };

/**
 * Returns the operator retry decision, regardless of the Attempt count. A retry of a running Run
 * with no open Attempt changes nothing; a retry of a running Attempt is rejected.
 */
export const retryRun = (current: RunProgress): RetryDecision => {
  const state = current.run.state;
  if (state._tag === "Failed") return { _tag: "Resume", state: RunState.retry(state) };
  if (state._tag === "Running" && Option.isNone(openAttempt(current))) {
    return { _tag: "ResumePending" };
  }
  return { _tag: "RetryRejected" };
};

/**
 * The Loop's previous sighting of an Item: `None` if never seen, `Some(None)` after a
 * non-matching sighting, and `Some(Some(event))` for the last submitted Event.
 */
export type PreviousSighting = Option.Option<Option.Option<EventId>>;

/**
 * Returns whether the previous sighting was a non-match or another Event than `eventId`. Returns
 * `false` if the Loop never saw the Item.
 */
export const cameBack = (previous: PreviousSighting, eventId: EventId): boolean =>
  Option.match(previous, {
    onNone: () => false,
    onSome: (observed) => !Option.contains(observed, eventId),
  });

/** The state of a recorded Event that has a Run or was ignored. */
export type Settlement =
  | { readonly _tag: "Owned"; readonly run: Run }
  | { readonly _tag: "Ignored"; readonly reason: IgnoreReason };

type SightingDecision =
  | { readonly _tag: "JoinRun"; readonly run: Run }
  | { readonly _tag: "StayIgnored"; readonly reason: IgnoreReason }
  | { readonly _tag: "ReopenEvent" };

/**
 * Returns what a new sighting of the `settled` Event does. The Event reopens only if the Item
 * came back (#267) and its Run was canceled or the queued Event was revoked.
 */
export const resightEvent = (settled: Settlement, itemCameBack: boolean): SightingDecision => {
  if (settled._tag === "Owned") {
    return settled.run.state._tag === "Canceled" && itemCameBack
      ? { _tag: "ReopenEvent" }
      : { _tag: "JoinRun", run: settled.run };
  }
  return settled.reason === "revoked" && itemCameBack
    ? { _tag: "ReopenEvent" }
    : { _tag: "StayIgnored", reason: settled.reason };
};

/**
 * The state that keeps a Loop from opening Runs for an Item after an Attempt stopped for the
 * operator: the stopped Run, and the Item's state after the stop once seen (#241, #341).
 */
export interface OperatorHold {
  readonly runId: RunId;
  readonly heldEventId: Option.Option<EventId>;
}

/** The kind of operator stop: a question or a blocker. */
export type OperatorStop = "question" | "blocker";

/** Returns the kind of operator stop that fails the Run in `decision`, or `None` (ADR 0017). */
export const operatorStop = (decision: FinishDecision): Option.Option<OperatorStop> => {
  if (decision._tag !== "RunFailed") return Option.none();
  switch (decision.outcome.failure._tag) {
    case "QuestionFailure":
      return Option.some("question");
    case "BlockedFailure":
      return Option.some("blocker");
    default:
      return Option.none();
  }
};

type HoldDecision =
  | { readonly _tag: "Hold" }
  | { readonly _tag: "HoldAt" }
  | { readonly _tag: "Release" };

/**
 * Returns what an unclaimed Event does during an operator hold. The first Event after the stop,
 * which usually contains the Agent's own comment, becomes the held state (`HoldAt`); a different
 * later Event releases the hold.
 */
export const holdEvent = (hold: OperatorHold, eventId: EventId): HoldDecision =>
  Option.match(hold.heldEventId, {
    onNone: (): HoldDecision => ({ _tag: "HoldAt" }),
    onSome: (held): HoldDecision => (held === eventId ? { _tag: "Hold" } : { _tag: "Release" }),
  });

type ClaimDecision =
  | { readonly _tag: "OpenRun" }
  | { readonly _tag: "QueueEvent" }
  | { readonly _tag: "SupersedeRun"; readonly runId: RunId; readonly state: RunState.Canceled };

/**
 * Returns what an unclaimed Event does: open a Run, queue behind the Item's running Run, or
 * supersede the Item's unstarted Run (ADR 0007).
 */
export const claimRun = (blocking: Option.Option<Run>, eventId: EventId): ClaimDecision => {
  if (Option.isNone(blocking)) return { _tag: "OpenRun" };
  const run = blocking.value;
  if (run.state._tag === "Running") return { _tag: "QueueEvent" };
  if (RunState.isUnstarted(run.state)) {
    return { _tag: "SupersedeRun", runId: run.id, state: RunState.supersede(run.state, eventId) };
  }
  return { _tag: "OpenRun" };
};
