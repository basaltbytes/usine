import type { ChildHost } from "@usine/agents/child-host";
import type { AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AgentFailure, type AttemptFailure, RunawayFailure } from "@usine/core/attempt/failure";
import { StepResult, type StepResultFact } from "@usine/core/step/result";
import { type AttemptReport, AttemptRequest, AttemptRuntime } from "@usine/durable/attempt-runtime";
import { Cause, Deferred, Effect, Exit, Fiber, Option, Ref, Result, type Scope } from "effect";
import { type AttemptWorkspace, ExecutorOperationError } from "./executor.ts";
import type { AttemptStop } from "./prepared-attempt.ts";

interface ActiveAttempt {
  readonly worker: AttemptWorkspace["worker"];
  /** The launch's scope: intervention delivery outlives its caller inside it. */
  readonly scope: Scope.Scope;
  /** Why the Attempt is stopping; the first reason wins. */
  readonly stopping: Ref.Ref<Option.Option<AttemptStop>>;
  /** The running `execute` call, interrupted when a stop's grace runs out. */
  readonly execution: Ref.Ref<Option.Option<Fiber.Fiber<AttemptReport, AttemptFailure>>>;
  readonly settled: Deferred.Deferred<void>;
}

/** What launch needs from the Attempt's checkout: where its children run, the environment its work runs in, the harvest once the parent finishes, and how to keep it for a reattachment. */
export interface DurableCheckout {
  /** The machine that holds the checkout, where the parent's children run. */
  readonly host: ChildHost;
  /** The only environment the parent's children and the harvesting commands see (ADR 0011). */
  readonly environment: Record<string, string>;
  /** Collects the commits and pull requests the checkout holds. */
  readonly harvest: Effect.Effect<ReadonlyArray<StepResultFact>, AttemptFailure>;
  /** Leaves the checkout in place when this process stops while the parent task stays live. */
  readonly keepForReattach: Effect.Effect<void>;
}

export interface DurableSessionOptions {
  /** Bounds each cancellation stage: the parent task's abort, then the Attempt settling. */
  readonly interruptGrace: Parameters<typeof Effect.timeoutOption>[1];
}

const cancelError = (attemptId: AttemptId, cause: unknown) =>
  new ExecutorOperationError({
    operation: "cancel",
    message: `Could not cancel Attempt ${attemptId}`,
    cause,
  });

/**
 * Runs Attempts whose Pi parent is a durable task in this process
 * (`AttemptRuntime`). Interrupting a launch that was not stopped first is
 * this process stopping: the parent task stays live in durable
 * storage and the checkout stays on disk for the reattachment after restart.
 * Every other way an Attempt ends leaves no live parent task behind.
 */
export const durableSessionFor = Effect.fn("DurableSession.for")(function* (
  options: DurableSessionOptions,
) {
  const runtime = yield* AttemptRuntime;
  const attempts = new Map<AttemptId, ActiveAttempt>();

  /** Cancels the Attempt's parent task if durable storage still holds it live; failures are logged, never raised. */
  const stopTask = Effect.fn("DurableSession.stopTask")(function* (
    attemptId: AttemptId,
    reason: string,
  ) {
    yield* Effect.annotateCurrentSpan({ attemptId, reason });
    const live = yield* runtime.isLive(attemptId).pipe(Effect.result);
    if (Result.isFailure(live)) {
      yield* Effect.logWarning("Could not read whether the Attempt's parent task is live", {
        attemptId,
        reason,
        errorTag: live.failure._tag,
        message: live.failure.message,
      });
      return;
    }
    if (!live.success) {
      yield* Effect.logDebug("The Attempt's parent task is not live; nothing to stop", {
        attemptId,
        reason,
      });
      return;
    }
    yield* Effect.logInfo("Canceling the Attempt's parent task", { attemptId, reason });
    const canceled = yield* runtime
      .cancel(attemptId)
      .pipe(Effect.timeoutOption(options.interruptGrace), Effect.result);
    if (Result.isFailure(canceled))
      yield* Effect.logWarning("The Attempt's parent task could not be canceled", {
        attemptId,
        reason,
        errorTag: canceled.failure._tag,
        message: canceled.failure.message,
      });
    else if (Option.isNone(canceled.success))
      yield* Effect.logWarning("Canceling the Attempt's parent task exceeded the interrupt grace", {
        attemptId,
        reason,
      });
  });

  const launch = Effect.fn("DurableSession.launch")(function* (
    prepared: AttemptWorkspace,
    io: AttemptChannel.Sink,
    checkout: DurableCheckout,
  ) {
    const spec = prepared.spec;
    const attemptId = spec.attemptId;
    yield* Effect.annotateCurrentSpan({ attemptId, worker: prepared.worker });
    const stopping = yield* Ref.make(Option.none<AttemptStop>());
    const execution = yield* Ref.make(Option.none<Fiber.Fiber<AttemptReport, AttemptFailure>>());
    const settled = yield* Deferred.make<void>();
    const run = Effect.gen(function* () {
      attempts.set(attemptId, {
        worker: prepared.worker,
        scope: yield* Effect.scope,
        stopping,
        execution,
        settled,
      });
      yield* Effect.logInfo("Running the Attempt's parent task", {
        attemptId,
        worker: prepared.worker,
        worktree: prepared.worktree,
        childHost: checkout.host._tag,
      });
      const running = yield* runtime
        .execute(
          new AttemptRequest({
            spec,
            worker: prepared.worker,
            cwd: prepared.worktree,
            host: checkout.host,
            environment: checkout.environment,
          }),
          io,
        )
        .pipe(Effect.forkScoped);
      yield* Ref.set(execution, Option.some(running));
      const executed = yield* Fiber.await(running);
      const stop = yield* Ref.get(stopping);
      if (Option.isSome(stop) && stop.value._tag === "Runaway")
        return yield* new RunawayFailure({ ceiling: stop.value.ceiling });
      if (
        Option.isSome(stop) &&
        Exit.isFailure(executed) &&
        Cause.hasInterruptsOnly(executed.cause)
      )
        return yield* new AgentFailure({ message: "The Attempt's parent task was canceled" });
      const report = yield* executed;
      const result = new StepResult({ message: report.message, facts: yield* checkout.harvest });
      yield* Effect.logInfo("The Attempt's parent task finished", {
        attemptId,
        facts: result.facts.length,
      });
      return result;
    });
    return yield* Effect.scoped(run).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          attempts.delete(attemptId);
          if (Exit.isFailure(exit)) {
            const stop = yield* Ref.get(stopping);
            if (Option.isNone(stop) && Cause.hasInterruptsOnly(exit.cause)) {
              yield* Effect.logInfo(
                "This process is stopping; the Attempt's parent task stays live for reattachment",
                { attemptId, worker: prepared.worker },
              );
              yield* checkout.keepForReattach;
            } else {
              yield* stopTask(
                attemptId,
                Option.match(stop, {
                  onNone: () => "the Attempt failed",
                  onSome: (reason) =>
                    reason._tag === "Cancel" ? "the Attempt was canceled" : "a ceiling tripped",
                }),
              );
            }
          }
          yield* Deferred.succeed(settled, undefined);
        }),
      ),
    );
  });

  /**
   * Stops a launched Attempt for `reason` and reports whether one was running
   * here: cancels its parent task, then waits for the Attempt to settle within
   * the grace before interrupting it. The launch fails with the first reason.
   */
  const stop = Effect.fn("DurableSession.stop")(function* (
    attemptId: AttemptId,
    reason: AttemptStop,
  ) {
    const active = attempts.get(attemptId);
    if (active === undefined) return false;
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan({ attemptId, worker: active.worker, stop: reason._tag });
        const first = yield* Ref.modify(active.stopping, (stopping) =>
          Option.isNone(stopping)
            ? ([true, Option.some(reason)] as const)
            : ([false, stopping] as const),
        );
        if (!first) {
          yield* Effect.logDebug("The Attempt is already stopping", {
            attemptId,
            worker: active.worker,
            stop: reason,
          });
          return true;
        }
        yield* Effect.logInfo("Canceling the Attempt's parent task", {
          attemptId,
          worker: active.worker,
          stop: reason,
        });
        const canceled = yield* runtime
          .cancel(attemptId)
          .pipe(Effect.timeoutOption(options.interruptGrace), Effect.result);
        const settledInGrace = yield* Deferred.await(active.settled).pipe(
          Effect.timeoutOption(options.interruptGrace),
        );
        if (Option.isNone(settledInGrace)) {
          yield* Effect.logWarning("The Attempt did not stop within the interrupt grace", {
            attemptId,
            worker: active.worker,
          });
          const running = yield* Ref.get(active.execution);
          if (Option.isSome(running)) {
            const stopped = yield* Fiber.interrupt(running.value).pipe(
              Effect.timeoutOption(options.interruptGrace),
            );
            if (Option.isNone(stopped))
              yield* Effect.logWarning("The Attempt's execution did not stop when interrupted", {
                attemptId,
                worker: active.worker,
              });
          }
        } else {
          yield* Effect.logInfo("The Attempt stopped within the interrupt grace", {
            attemptId,
            worker: active.worker,
          });
        }
        if (Result.isFailure(canceled)) {
          yield* Effect.logWarning("The Attempt's parent task could not be canceled", {
            attemptId,
            worker: active.worker,
            errorTag: canceled.failure._tag,
            message: canceled.failure.message,
          });
          return yield* cancelError(attemptId, canceled.failure);
        }
        if (Option.isNone(canceled.success)) {
          yield* Effect.logWarning("Canceling the parent task exceeded the interrupt grace", {
            attemptId,
            worker: active.worker,
          });
          return yield* cancelError(
            attemptId,
            new Error("canceling the parent task exceeded the interrupt grace"),
          );
        }
        return true;
      }),
    );
  });

  const intervene = Effect.fn("DurableSession.intervene")(function* (
    attemptId: AttemptId,
    intervention: AttemptChannel.Intervention,
  ) {
    yield* Effect.annotateCurrentSpan({
      attemptId,
      target: intervention.target._tag,
      action: intervention.action._tag,
    });
    const active = attempts.get(attemptId);
    if (active === undefined || Option.isSome(yield* Ref.get(active.stopping)))
      return yield* new AgentFailure({
        message: "This Attempt has no live session in this orchestrator",
      });
    yield* runtime.intervene(attemptId, intervention).pipe(
      Effect.tap(() =>
        Effect.logInfo("Operator input delivered to the Attempt's parent task", {
          attemptId,
          action: intervention.action._tag,
        }),
      ),
      Effect.tapError((error) =>
        Effect.logWarning("Operator input delivery failed", {
          attemptId,
          action: intervention.action._tag,
          errorTag: error._tag,
        }),
      ),
      // Delivery belongs to the Attempt, so a disconnected HTTP caller cannot cut it short.
      Effect.forkIn(active.scope),
      Effect.flatMap(Fiber.join),
    );
  });

  return { launch, stop, intervene, stopTask } as const;
});
