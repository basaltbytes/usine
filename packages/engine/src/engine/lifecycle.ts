import { Attempt, AttemptId, AttemptNumber, shouldAutoRetry } from "@usine/core/attempt";
import { AttemptFailure, InfraFailure } from "@usine/core/attempt/failure";
import { AttemptCanceled, AttemptFailed, AttemptSucceeded } from "@usine/core/attempt/outcome";
import type { SalvagePushed } from "@usine/core/attempt/salvage";
import { EventId } from "@usine/core/event";
import { Run, RunId } from "@usine/core/run";
import * as RunState from "@usine/core/run/state";
import { StepResult } from "@usine/core/step/result";
import { Array as EffectArray, Option, Result } from "effect";
import type { WorkflowCommand } from "../workflow/command.ts";

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
  policy: "Execution" | "FinalReconciliation",
): RetryAttempt | RunFailed => {
  const outcome = new AttemptFailed({ failure });
  if (
    policy === "Execution" &&
    shouldAutoRetry({ failure, number: attempt.number, maxAutoAttempts: MAX_AUTO_ATTEMPTS })
  ) {
    return { _tag: "RetryAttempt", attempt, outcome };
  }
  return { _tag: "RunFailed", attempt, outcome, state: RunState.fail(state) };
};

const finish = (
  current: RunProgress,
  attemptId: AttemptId,
  result: Result.Result<StepResult, AttemptFailure>,
  policy: "Execution" | "FinalReconciliation",
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
    return failRunningAttempt(current.run.state, attempt.value, result.failure, policy);
  }
  return {
    _tag: "RunSucceeded",
    attempt: attempt.value,
    outcome: new AttemptSucceeded(),
    state: RunState.succeed(current.run.state),
    result: result.success,
  };
};

/**
 * Settles the current Attempt from its executor result. Infrastructure failure
 * can retry up to three total Attempts; a late or repeated completion changes nothing.
 */
export const finishAttempt = (
  current: RunProgress,
  attemptId: AttemptId,
  result: Result.Result<StepResult, AttemptFailure>,
): FinishDecision => finish(current, attemptId, result, "Execution");

/**
 * Repairs an open Attempt from a final durable result. The workflow has already
 * ended, so even an infrastructure failure closes the Run without auto-retry.
 * The runtime must first translate its completion into a typed result; defects
 * and suspension are not Attempt outcomes here (ADRs 0003 and 0010).
 */
export const reconcileAttempt = (
  current: RunProgress,
  result: Result.Result<StepResult, AttemptFailure>,
): FinishDecision => {
  const attempt = openAttempt(current);
  return Option.isNone(attempt)
    ? { _tag: "Unchanged", reason: "NoOpenAttempt" }
    : finish(current, attempt.value.id, result, "FinalReconciliation");
};

type StartDecision =
  | {
      readonly _tag: "StartAttempt";
      readonly state: RunState.Running;
      readonly number: AttemptNumber;
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
 * pushed salvage the Attempt's checkout starts from, if any.
 */
export const beginAttempt = (
  current: RunProgress,
  interruption: InfraFailure,
  live: Option.Option<AttemptId>,
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
    const recovery = failRunningAttempt(state, attempt.value, interruption, "Execution");
    if (recovery._tag === "RunFailed") return recovery;
    interrupted = Option.some(recovery);
  }
  return {
    _tag: "StartAttempt",
    state: state._tag === "Running" ? state : RunState.start(state),
    number: AttemptNumber.make((current.attempts.at(-1)?.number ?? 0) + 1),
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
 * Repeating the request is accepted while its Resume command remains pending;
 * after delivery, retrying a Running Run is rejected.
 */
export const retryRun = (
  state: RunState.RunState,
  pendingCommands: ReadonlyArray<WorkflowCommand>,
): RetryDecision => {
  if (state._tag === "Failed") return { _tag: "Resume", state: RunState.retry(state) };
  if (state._tag === "Running" && pendingCommands.includes("Resume")) {
    return { _tag: "ResumePending" };
  }
  return { _tag: "RetryRejected" };
};

type ClaimDecision =
  | { readonly _tag: "OpenRun" }
  | { readonly _tag: "QueueEvent" }
  | { readonly _tag: "SupersedeRun"; readonly runId: RunId; readonly state: RunState.Canceled };

/**
 * Places a previously unclaimed Event behind its Item's running work, or
 * replaces unstarted work. The ledger must resolve permanent deduplication and
 * ignored Events before this decision; running Attempts always finish (ADR 0007).
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
