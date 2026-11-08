import type { CommitSha } from "@usine/core/repository";
import { ItemNumber } from "@usine/core/item";
import type { OperatorActor } from "@usine/core/operator";
import {
  Attempt,
  AttemptId,
  AttemptNumber,
  MAX_AUTO_ATTEMPTS,
  pendingProviderRetry,
  shouldAutoRetry,
} from "@usine/core/attempt";
import { ciHandoff, CiHandoff, type CiLabelMutation, type CiPolicy } from "@usine/core/ci";
import { AttemptFailure, AgentFailure, InfraFailure } from "@usine/core/attempt/failure";
import {
  AttemptAwaitingCi,
  AttemptCanceled,
  AttemptFailed,
  AttemptSucceeded,
} from "@usine/core/attempt/outcome";
import { type AttemptSalvage, SalvagePushed } from "@usine/core/attempt/salvage";
import {
  type AttemptStart,
  type OperatorRetryStart,
  StartedAfterRestart,
  StartedByEvent,
  StartedByInfraRetry,
  StartedByProviderRetry,
} from "@usine/core/attempt/start";
import { EventId } from "@usine/core/event";
import { Run, RunId } from "@usine/core/run";
import * as RunState from "@usine/core/run/state";
import { StepResult } from "@usine/core/step/result";
import { Array as EffectArray, Data, Match, Option, Result } from "effect";
import type { IgnoreReason } from "./submission.ts";

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
  /** The result of a rejected report, which the failed Attempt keeps. */
  readonly harvested: Option.Option<StepResult>;
};

type RunFailed = {
  readonly _tag: "RunFailed";
  readonly attempt: Attempt;
  readonly outcome: AttemptFailed;
  readonly state: RunState.Failed;
  /** The result of a rejected report, which the failed Attempt keeps. */
  readonly harvested: Option.Option<StepResult>;
};

type RunSucceeded = {
  readonly _tag: "RunSucceeded";
  readonly attempt: Attempt;
  readonly outcome: AttemptSucceeded;
  readonly state: RunState.Succeeded;
  readonly result: StepResult;
};

type RunAwaitingCi = {
  readonly _tag: "RunAwaitingCi";
  readonly attempt: Attempt;
  readonly outcome: AttemptAwaitingCi;
  readonly state: RunState.AwaitingCi;
  readonly result: StepResult;
};

/** The changes committed together when an Attempt finishes. */
export type FinishDecision = RetryAttempt | RunFailed | RunSucceeded | RunAwaitingCi | Unchanged;

/**
 * A successful report that the completion check rejected. The Attempt fails with `failure` and
 * keeps `result`.
 */
export class RejectedCompletion extends Data.TaggedClass("RejectedCompletion")<{
  readonly failure: AgentFailure;
  readonly result: StepResult;
}> {}

/** The executor result of an Attempt, or its successful report that the completion check rejected. */
export type AttemptResult = Result.Result<StepResult, AttemptFailure | RejectedCompletion>;

const openAttempt = (current: RunProgress): Option.Option<Attempt> =>
  Option.fromNullishOr(current.attempts.at(-1)).pipe(
    Option.filter((attempt) => Option.isNone(attempt.outcome)),
  );

/** Returns the open Attempt `attemptId` of the running Run, or why its result changes nothing. */
const runningAttempt = (
  current: RunProgress,
  attemptId: AttemptId,
): Result.Result<{ readonly state: RunState.Running; readonly attempt: Attempt }, Unchanged> => {
  const state = current.run.state;
  if (state._tag !== "Running") return Result.fail({ _tag: "Unchanged", reason: "RunNotRunning" });
  const attempt = openAttempt(current);
  if (Option.isNone(attempt)) return Result.fail({ _tag: "Unchanged", reason: "NoOpenAttempt" });
  // A result from before a restart or retry doesn't apply to the replacement Attempt.
  if (attempt.value.id !== attemptId)
    return Result.fail({ _tag: "Unchanged", reason: "AttemptReplaced" });
  return Result.succeed({ state, attempt: attempt.value });
};

const pushFailureOf = (attempt: Attempt) =>
  Option.flatMap(attempt.salvage, (salvage) =>
    salvage._tag === "Retained" ? salvage.pushFailure : Option.none(),
  );

/**
 * Returns why `finishAttempt` would not record a success of `attemptId`: the Run isn't running,
 * another Attempt replaced it, or its push failed. Returns `None` if it can record one.
 */
export const discardedSuccess = (
  current: RunProgress,
  attemptId: AttemptId,
): Option.Option<Unchanged["reason"] | "PushFailed"> =>
  Result.match(runningAttempt(current, attemptId), {
    onFailure: ({ reason }) => Option.some(reason),
    onSuccess: ({ attempt }) =>
      Option.isSome(pushFailureOf(attempt)) ? Option.some("PushFailed" as const) : Option.none(),
  });

const failRunningAttempt = (
  state: RunState.Running,
  attempt: Attempt,
  failure: AttemptFailure,
  harvested: Option.Option<StepResult> = Option.none(),
): RetryAttempt | RunFailed => {
  const outcome = AttemptFailed.make({ failure });
  if (
    shouldAutoRetry({
      failure,
      number: attempt.number,
      maxAutoAttempts: MAX_AUTO_ATTEMPTS,
    })
  ) {
    return { _tag: "RetryAttempt", attempt, outcome, harvested };
  }
  return { _tag: "RunFailed", attempt, outcome, state: RunState.fail(state), harvested };
};

/**
 * Returns the changes for the executor result of `attemptId`. Infrastructure and capacity failures
 * allow up to 3 Attempts in total; a late or repeated result returns `Unchanged`.
 */
export const finishAttempt = (
  current: RunProgress,
  attemptId: AttemptId,
  result: AttemptResult,
  policy: Option.Option<CiPolicy> = Option.none(),
  inheritedOnGreen: ReadonlyArray<CiLabelMutation> = [],
): FinishDecision => {
  const running = runningAttempt(current, attemptId);
  if (Result.isFailure(running)) return running.failure;
  const { state, attempt } = running.success;
  const completed = Option.match(pushFailureOf(attempt), {
    onNone: () => result,
    onSome: (failure) => Result.fail(failure),
  });
  if (Result.isFailure(completed)) {
    const failed = completed.failure;
    return failed._tag === "RejectedCompletion"
      ? failRunningAttempt(state, attempt, failed.failure, Option.some(failed.result))
      : failRunningAttempt(state, attempt, failed);
  }
  const handoff = ciHandoff(completed.success.message);
  if (Result.isFailure(handoff)) {
    return failRunningAttempt(state, attempt, handoff.failure);
  }
  const pullRequest = completed.success.facts.find(
    (fact) => fact._tag === "PullRequest" && Option.isSome(fact.head),
  );
  const required = Option.match(policy, {
    onNone: () => handoff.success,
    onSome: (ci) =>
      Option.match(handoff.success, {
        onSome: (recorded) => Option.some(CiHandoff.make({ ...recorded, ...ci })),
        onNone: () =>
          pullRequest?._tag === "PullRequest" && Option.isSome(pullRequest.head)
            ? Option.some(
                CiHandoff.make({
                  ...ci,
                  pullRequest: ItemNumber.make(pullRequest.number),
                  head: pullRequest.head.value,
                  onGreen: [],
                }),
              )
            : Option.none(),
      }),
  });
  if (Option.isSome(policy) && Option.isNone(required))
    return failRunningAttempt(
      state,
      attempt,
      AgentFailure.make({
        message: "This loop requires CI, but the successful report has no pushed pull request head",
      }),
    );
  if (Option.isSome(required)) {
    const request = CiHandoff.make({
      ...required.value,
      onGreen: [...inheritedOnGreen, ...required.value.onGreen],
    });
    if (
      !completed.success.facts.some(
        (fact) =>
          fact._tag === "PullRequest" &&
          fact.number === request.pullRequest &&
          Option.contains(fact.head, request.head),
      )
    ) {
      return failRunningAttempt(
        state,
        attempt,
        InfraFailure.make({
          message: "The CI handoff has no harvested pull request for the checkout's pushed head",
          cause: { pullRequest: request.pullRequest, head: request.head },
        }),
      );
    }
    return {
      _tag: "RunAwaitingCi",
      attempt,
      outcome: AttemptAwaitingCi.make(),
      state: RunState.AwaitingCi.make({ handoff: request }),
      result: completed.success,
    };
  }
  return {
    _tag: "RunSucceeded",
    attempt,
    outcome: AttemptSucceeded.make(),
    state: RunState.succeed(state),
    result: completed.success,
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

/** Returns the part of `salvage` that another Worker can fetch, if any. */
const pushedPart = (salvage: AttemptSalvage): Option.Option<SalvagePushed> =>
  Match.valueTags(salvage, {
    Pushed: (pushed) => Option.some(pushed),
    PartlyPushed: ({ ref, commit }) => Option.some(SalvagePushed.make({ ref, commit })),
    Retained: () => Option.none(),
    Rejected: () => Option.none(),
  });

// Only a pushed salvage can be fetched on another Worker, so a retry resumes from the newest one.
const newestPushedSalvage = (attempts: ReadonlyArray<Attempt>): Option.Option<SalvagePushed> =>
  EffectArray.findLast(attempts, (attempt) => Option.flatMap(attempt.salvage, pushedPart));

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
    const recovery = failRunningAttempt(
      state,
      attempt.value,
      Option.getOrElse(pushFailureOf(attempt.value), () => interruption),
    );
    if (recovery._tag === "RunFailed") return recovery;
    interrupted = Option.some(recovery);
  }
  const start: AttemptStart = Option.isSome(interrupted)
    ? StartedAfterRestart.make()
    : Option.getOrElse(requested, (): AttemptStart => {
        if (current.attempts.length === 0) return StartedByEvent.make();
        return Option.isSome(pendingProviderRetry(state, current.attempts))
          ? StartedByProviderRetry.make()
          : StartedByInfraRetry.make();
      });
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
  | { readonly _tag: "CancelRejected" }
  | {
      readonly _tag: "Canceled";
      readonly state: RunState.Canceled;
      readonly attempt: Option.Option<{
        readonly id: AttemptId;
        readonly worker: Attempt["worker"];
        readonly outcome: AttemptCanceled;
      }>;
    };

/** Returns the cancel decision for an open Run and its open Attempt, if any. */
export const cancelRun = (
  current: RunProgress,
  by: Option.Option<OperatorActor> = Option.none(),
): CancelDecision => {
  if (current.run.state._tag === "Canceled") return { _tag: "AlreadyClosed" };
  if (!RunState.isOpen(current.run.state)) return { _tag: "CancelRejected" };
  return {
    _tag: "Canceled",
    state: RunState.cancelByOperator(current.run.state, by),
    attempt:
      current.run.state._tag === "Running"
        ? Option.map(openAttempt(current), (attempt) => ({
            id: attempt.id,
            worker: attempt.worker,
            outcome: AttemptCanceled.make(),
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
export interface Suppression {
  readonly runId: RunId;
  readonly suppressedEventId: Option.Option<EventId>;
}

/** The kind of operator stop: a question or a blocker. */
export type OperatorStop = "question" | "blocker";

/** Preserves the original operator stop when a push failure replaces its displayed outcome (ADR 0017). */
export const operatorStop = (
  decision: FinishDecision,
  result: AttemptResult,
): Option.Option<OperatorStop> => {
  if (decision._tag !== "RunFailed") return Option.none();
  if (Result.isSuccess(result)) return Option.none();
  switch (result.failure._tag) {
    case "QuestionFailure":
      return Option.some("question");
    case "BlockedFailure":
      return Option.some("blocker");
    default:
      return Option.none();
  }
};

type SuppressionDecision =
  | { readonly _tag: "Suppress" }
  | { readonly _tag: "SuppressFrom" }
  | { readonly _tag: "Lift" };

/**
 * Returns what an unclaimed Event does during a suppression. The first Event after the stop,
 * which usually contains the Agent's own comment, becomes the suppressed state (`SuppressFrom`);
 * a different later Event lifts the suppression.
 */
export const suppressionDecision = (
  suppression: Suppression,
  eventId: EventId,
): SuppressionDecision =>
  Option.match(suppression.suppressedEventId, {
    onNone: (): SuppressionDecision => ({ _tag: "SuppressFrom" }),
    onSome: (suppressed): SuppressionDecision =>
      suppressed === eventId ? { _tag: "Suppress" } : { _tag: "Lift" },
  });

type ClaimDecision =
  | { readonly _tag: "OpenRun" }
  | { readonly _tag: "QueueEvent" }
  | { readonly _tag: "SupersedeRun"; readonly runId: RunId; readonly state: RunState.Canceled };

/**
 * Returns what an unclaimed Event does: open a Run, queue behind the Item's running Run, or
 * supersede the Item's unstarted Run (ADR 0007).
 */
export const claimRun = (
  blocking: Option.Option<Run>,
  eventId: EventId,
  ciFailureHead: Option.Option<CommitSha> = Option.none(),
): ClaimDecision => {
  if (Option.isNone(blocking)) return { _tag: "OpenRun" };
  const run = blocking.value;
  if (
    run.state._tag === "AwaitingCi" &&
    run.state.handoff.fixLoop === run.loop &&
    Option.contains(ciFailureHead, run.state.handoff.head)
  )
    return { _tag: "OpenRun" };
  if (run.state._tag === "Running" || run.state._tag === "AwaitingCi")
    return { _tag: "QueueEvent" };
  if (RunState.isUnstarted(run.state)) {
    return { _tag: "SupersedeRun", runId: run.id, state: RunState.supersede(run.state, eventId) };
  }
  return { _tag: "OpenRun" };
};
