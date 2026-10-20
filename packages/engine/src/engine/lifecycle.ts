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

// Engine policy, not a limit imposed on consumers of the core Attempt model.
const MAX_AUTO_ATTEMPTS = AttemptNumber.make(3);

/** A Run and its Attempts in ascending attempt-number order, read together. */
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

/** Changes that must commit together when an Attempt finishes. Only success stores a Step result. */
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
 * Settles the current Attempt from its executor result. Infrastructure failure
 * can retry up to three total Attempts; a late or repeated completion changes nothing.
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
  // A completion from before restart or operator retry cannot settle the
  // replacement Attempt, even though the Run is Running again.
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

// Only a pushed salvage can be fetched on the next Worker. A later Attempt
// whose own push failed keeps its worktree on that Worker, so the retry resumes
// from the newest salvage that was published.
const newestPushedSalvage = (attempts: ReadonlyArray<Attempt>): Option.Option<SalvagePushed> =>
  EffectArray.findLast(attempts, (attempt) =>
    Option.filter(
      attempt.salvage,
      (salvage): salvage is SalvagePushed => salvage._tag === "Pushed",
    ),
  );

/**
 * Admits the next Attempt after a Worker reservation. An unfinished previous
 * Attempt indicates a restart. When its parent task is still `live`, the
 * Attempt is reattached: it keeps its identity and number and spends no retry.
 * Otherwise it counts against the same retry cap as ordinary infrastructure
 * failure, with `interruption` as the runtime's explanation. The caller creates
 * a new Attempt's identity and timestamp only when admitted. `resume` names the
 * pushed salvage the Attempt's checkout starts from, if any. `requested` is the
 * operator retry that reopened the Run, if one did; otherwise a later Attempt
 * follows an infrastructure failure or a restart, and the first one the Event.
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

/**
 * Cancels open work and, if executing, its unfinished Attempt. A Run awaiting
 * capacity may have no Attempt, or only the closed Attempt preceding a retry.
 */
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
 * Reopens a failed Run for operator retry regardless of its Attempt count.
 * A request while the Run runs but has no open Attempt, as after a retry that
 * has not started its Attempt yet, is accepted and changes nothing; once an
 * Attempt is open, retrying is rejected.
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
 * What a Loop saw of an Item before the current sighting: none when the Loop
 * never saw it, `Some(None)` after a sighting that did not match, and
 * `Some(Some(event))` for the Event a trigger last submitted.
 */
export type PreviousSighting = Option.Option<Option.Option<EventId>>;

/**
 * Whether a sighting of `eventId` finds the Item back in a state the Loop had
 * left: since it last saw this Event, the Loop saw the Item not matching or saw
 * another Event. An Item the Loop never saw before has not come back.
 */
export const cameBack = (previous: PreviousSighting, eventId: EventId): boolean =>
  Option.match(previous, {
    onNone: () => false,
    onSome: (observed) => !Option.contains(observed, eventId),
  });

/** How an Event already settled before this sighting: it owns a Run, or it was ignored. */
export type Settlement =
  | { readonly _tag: "Owned"; readonly run: Run }
  | { readonly _tag: "Ignored"; readonly reason: IgnoreReason };

type SightingDecision =
  | { readonly _tag: "JoinRun"; readonly run: Run }
  | { readonly _tag: "StayIgnored"; readonly reason: IgnoreReason }
  | { readonly _tag: "ReopenEvent" };

/**
 * Decides what a new sighting of a settled Event does. The Event opens again
 * only when the Item came back to its state (#267) and nothing worked on that
 * state: its Run was canceled, by the operator, a supersede, or a revoke, or the
 * Event was revoked while it waited in the queue. A Run that succeeded or failed
 * keeps its Event, and a failed Run waits for operator retry. An Event that a
 * newer Event superseded in the queue stays ignored.
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
 * A hold of a Loop on an Item after an Attempt stopped for the operator: the
 * Run whose Attempt stopped, and the Item's state after the stop once the
 * Loop saw one (#241, #341).
 */
export interface OperatorHold {
  readonly runId: RunId;
  readonly heldEventId: Option.Option<EventId>;
}

/** How an Attempt stopped for the operator: it asked a question or reported a blocker. */
export type OperatorStop = "question" | "blocker";

/** How the Attempt the decision closes stopped for the operator, if it did; its Loop then holds the Item (ADR 0017). */
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
 * Decides what an unclaimed Event does while a hold keeps its Loop on the Item.
 * The first state the Loop sees after the stop normally carries the Agent's
 * own question or blocker comment, so it becomes the held state (`HoldAt`); a
 * later Event with other content means the Item changed again, and the Loop
 * acts on it.
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
 * Decides what to do with an Event that no Run has claimed: open a Run, queue the Event
 * while the Item's Run is running, or supersede the Item's unstarted Run. The ledger handles
 * duplicate and ignored Events before this decision; a running Attempt always finishes (ADR 0007).
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
