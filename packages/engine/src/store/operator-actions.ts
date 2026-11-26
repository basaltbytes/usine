import { ChangeBus } from "@usine/core/changes";
import { ActingMember, type OperatorActor } from "@usine/core/operator";
import { Attempt, AttemptId, FailureResolution } from "@usine/core/attempt";
import { AttemptCanceled } from "@usine/core/attempt/outcome";
import { StartedByEditAndRetry, StartedByRetry } from "@usine/core/attempt/start";
import { Event } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RunId } from "@usine/core/run";
import { ApprovalSource } from "@usine/core/run/approval";
import * as RunState from "@usine/core/run/state";
import { StepResult } from "@usine/core/step/result";
import { Array as EffectArray, DateTime, Effect, Option } from "effect";
import { RunDatabase } from "../database/database.ts";
import { RunOperationRejectedError, RunRetryBlockedError } from "../engine/error.ts";
import type { CapacityWait } from "../engine/capacity/state.ts";
import type { RetryOutcome, RetryRequest } from "../engine/retry.ts";
import { cancelRun, retryRun } from "../engine/lifecycle.ts";
import { persistence } from "./codec.ts";
import { runTransaction } from "./queries/queries.ts";
import { TranscriptCodec } from "./transcript/codec.ts";

/** The result of `RunStore.cancel`, decided in the closing transaction, with the Run's Loop and Item. */
export type CancelOutcome =
  | { readonly _tag: "AlreadyClosed" }
  | {
      readonly _tag: "Canceled";
      readonly openAttempt: Option.Option<Pick<Attempt, "id" | "worker">>;
      readonly loop: LoopName;
      readonly itemKey: ItemKey;
    };

/** Returns the `RunStore` operations that apply an operator's approval, retry, resolution, or cancellation. */
export const operatorActions = Effect.gen(function* () {
  const database = yield* RunDatabase;
  const bus = yield* ChangeBus;
  const codec = yield* TranscriptCodec;
  const inTransaction = runTransaction(database, bus, codec);

  const resolveFailure = Effect.fn("RunStore.resolveFailure")(function* (
    runId: RunId,
    attemptId: AttemptId,
    operator: Option.Option<OperatorActor>,
  ) {
    yield* Effect.annotateCurrentSpan({ runId, attemptId });
    return yield* inTransaction((tx) =>
      Effect.gen(function* () {
        const current = yield* tx.snapshot(runId);
        const latest = current.attempts.at(-1);
        if (
          !RunState.operatorActions(current.run.state).canResolveFailure ||
          latest?.id !== attemptId
        ) {
          yield* Effect.logInfo("Failure resolution rejected; Run or Attempt changed", {
            runId,
            attemptId,
            state: current.run.state._tag,
            latestAttemptId: latest?.id,
          });
          return yield* RunOperationRejectedError.make({
            runId,
            operation: "resolveFailure",
            state: current.run.state._tag,
          });
        }
        if (Option.contains(current.resolvedFailureAttemptId, attemptId)) {
          yield* Effect.logInfo("Run failure already resolved", { runId, attemptId });
          return false;
        }

        const resolution = FailureResolution.make({ resolvedAt: yield* DateTime.now, operator });
        yield* tx.resolveFailure(runId, attemptId, resolution);
        const lifted = yield* tx.loopItems.liftRun(runId);
        yield* Effect.logInfo("Run failure resolved", {
          runId,
          attemptId,
          liftedSuppression: lifted,
          resolvedAt: DateTime.formatIso(resolution.resolvedAt),
          operator: Option.getOrNull(operator),
        });
        return lifted;
      }),
    );
  }, persistence("resolve run failure"));

  const approve = Effect.fn("RunStore.approve")(function* (
    runId: RunId,
    approval: Event,
    source: ApprovalSource,
  ) {
    yield* Effect.annotateCurrentSpan({ runId, eventId: approval.id, channel: source.channel });
    return yield* inTransaction((tx) =>
      Effect.gen(function* () {
        if (yield* tx.approvalExists(runId)) return false;
        const current = yield* tx.snapshot(runId);
        if (current.run.state._tag !== "Waiting") {
          return yield* RunOperationRejectedError.make({
            runId,
            operation: "approve",
            state: current.run.state._tag,
          });
        }
        yield* tx.recordApproval(runId, approval, source);
        yield* tx.updateState(runId, RunState.approve(current.run.state));
        return true;
      }),
    );
  }, persistence("approve run"));

  const retry = Effect.fn("RunStore.retry")(function* (
    runId: RunId,
    request: RetryRequest,
    wait: Option.Option<CapacityWait>,
  ) {
    const { amendment, requestedBy } = request;
    yield* Effect.annotateCurrentSpan({ runId });
    return yield* inTransaction((tx) =>
      Effect.gen(function* () {
        const current = yield* tx.snapshot(runId);
        const decision = retryRun(current, wait);
        yield* Effect.logInfo("Operator retry decided", {
          runId,
          state: current.run.state._tag,
          decision: decision._tag,
        });
        if (decision._tag === "Resume") {
          // A later Event can have opened another Run of this Loop on the Item; reopening this one
          // would run both.
          const blocking = (yield* tx.blockingRun(current.run.loop, current.itemKey))[0];
          if (blocking !== undefined) {
            yield* Effect.logInfo("Operator retry rejected; another Run is open on the Item", {
              runId,
              openRunId: blocking.runId,
              loop: current.run.loop,
              itemKey: current.itemKey,
            });
            return yield* RunRetryBlockedError.make({
              runId,
              openRunId: blocking.runId,
              message: `Cannot retry run ${runId}: run ${blocking.runId} of loop "${current.run.loop}" is open on the same item. Cancel run ${blocking.runId}, or try again after it closes.`,
            });
          }
          // Preserve attribution for results stored before producing attempt IDs were recorded.
          if (
            Option.isSome(current.step.result) &&
            Option.isNone(current.step.result.value.attemptId)
          ) {
            const producer = EffectArray.findLast(
              current.attempts,
              ({ stepName }) => stepName === current.step.name,
            );
            if (Option.isSome(producer)) {
              yield* tx.updateStepResult(
                runId,
                current.step.name,
                StepResult.make({
                  ...current.step.result.value,
                  attemptId: Option.some(producer.value.id),
                }),
              );
              yield* Effect.logInfo("Recorded producing attempt for a legacy step result", {
                runId,
                attemptId: producer.value.id,
              });
            }
          }
          if (Option.isSome(amendment)) {
            yield* tx.amend(runId, amendment.value);
            yield* Effect.logInfo("Run effective task and Agent amended", {
              runId,
              agent: amendment.value.agent.name,
            });
          }
          // A retry lifts the suppression, so Events queue behind the running Run again.
          if (yield* tx.loopItems.liftRun(runId)) {
            yield* Effect.logInfo("Operator retry lifts the suppression of the Item", { runId });
          }
          yield* tx.setNextStart(
            runId,
            Option.some(
              Option.isSome(amendment)
                ? StartedByEditAndRetry.make({ operator: requestedBy })
                : StartedByRetry.make({ operator: requestedBy }),
            ),
          );
          yield* tx.updateState(runId, decision.state);
          return "Reopened" satisfies RetryOutcome;
        }
        if (decision._tag === "RetryNow") {
          if (Option.isSome(amendment)) {
            yield* tx.amend(runId, amendment.value);
            yield* Effect.logInfo("Run effective task and Agent amended", {
              runId,
              agent: amendment.value.agent.name,
            });
          }
          yield* tx.setNextStart(
            runId,
            Option.some(
              Option.isSome(amendment)
                ? StartedByEditAndRetry.make({ operator: requestedBy })
                : StartedByRetry.make({ operator: requestedBy }),
            ),
          );
          yield* Effect.logInfo(
            "Operator retry starts the next Attempt of a Run that waits for provider capacity",
            { runId, state: current.run.state._tag, attempts: current.attempts.length },
          );
          return "Forced" satisfies RetryOutcome;
        }
        if (decision._tag === "ResumePending" && Option.isNone(amendment))
          return "Unchanged" satisfies RetryOutcome;
        return yield* RunOperationRejectedError.make({
          runId,
          operation: "retry",
          state: current.run.state._tag,
        });
      }),
    );
  }, persistence("retry run"));

  const cancel = Effect.fn("RunStore.cancel")(function* (runId: RunId) {
    yield* Effect.annotateCurrentSpan({ runId });
    return yield* inTransaction((tx) =>
      Effect.gen(function* () {
        const current = yield* tx.snapshot(runId);
        const actor = yield* ActingMember;
        const decision = cancelRun(current, actor);
        yield* Effect.logInfo("Operator cancellation decided", {
          runId,
          state: current.run.state._tag,
          decision: decision._tag,
        });
        if (decision._tag === "AlreadyClosed") return decision;
        if (decision._tag === "CancelRejected")
          return yield* RunOperationRejectedError.make({
            runId,
            operation: "cancel",
            state: current.run.state._tag,
          });
        const canceledAt = yield* DateTime.now;
        if (Option.isSome(decision.attempt)) {
          const { id, outcome } = decision.attempt.value;
          yield* tx.closeAttempt(id, outcome, canceledAt);
        }
        if (current.run.state._tag === "AwaitingCi")
          yield* tx.settleCiAttempt(runId, AttemptCanceled.make());
        yield* tx.updateState(runId, decision.state, canceledAt);
        const canceled: CancelOutcome = {
          _tag: "Canceled",
          openAttempt: Option.map(decision.attempt, ({ id, worker }) => ({ id, worker })),
          loop: current.run.loop,
          itemKey: current.itemKey,
        };
        return canceled;
      }),
    );
  }, persistence("cancel run"));

  return { approve, retry, resolveFailure, cancel } as const;
});
