import type { ChildHost } from "@usine/agents/child-host";
import type { AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AgentFailure, type AttemptFailure, RunawayFailure } from "@usine/core/attempt/failure";
import type { AttemptRecovery } from "@usine/core/attempt/salvage";
import { StepResult, type StepResultFact } from "@usine/core/step/result";
import { type AttemptReport, AttemptRequest, AttemptRuntime } from "@usine/durable/attempt-runtime";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Match,
  Option,
  Ref,
  Result,
  type Scope,
} from "effect";
import {
  type AttemptWorkspace,
  type CheckoutRequest,
  type ExecutorError,
  ExecutorOperationError,
} from "./executor.ts";
import { type AcquiredAttempt, type AttemptStop, preparedAttemptsFor } from "./prepared-attempt.ts";

interface ActiveAttempt {
  readonly worker: AttemptWorkspace["worker"];
  /** The launch's scope: intervention delivery outlives its caller inside it. */
  readonly scope: Scope.Scope;
  /** Why the Attempt is stopping; the first reason wins. */
  readonly stopping: Ref.Ref<Option.Option<AttemptStop>>;
  /** The running `execute` call, interrupted when a stop's grace runs out. */
  readonly execution: Ref.Ref<Option.Option<Fiber.Fiber<AttemptReport, AttemptFailure>>>;
  /** The run has ended: the session takes no more operator input and no further stop; only its release remains. */
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
 * (`AttemptRuntime`), for every Worker kind: the executors supply the
 * checkout, and everything about the parent task lives here. Interrupting a
 * launch that was not stopped first is this process stopping: the parent
 * task stays live in durable storage and the checkout stays on disk for the
 * reattachment after restart. Every other way an Attempt ends leaves no live
 * parent task behind.
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
      yield* runtime.recordResult(attemptId, result).pipe(
        Effect.tapError((error) =>
          Effect.logWarning(
            "Could not record the Attempt's result in durable storage; a restart before the Run records it harvests the checkout again",
            { attemptId, errorTag: error._tag, message: error.message },
          ),
        ),
        Effect.ignore,
      );
      return result;
    });
    return yield* Effect.scoped(run).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          // Settle first: from here `stop` and `intervene` see an ended run, so
          // `stopping` is final when the branches below read it.
          yield* Deferred.succeed(settled, undefined);
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
        }),
      ),
    );
  });

  /**
   * Stops a launched Attempt for `reason` and reports whether one was running
   * here: cancels its parent task, then waits for the Attempt to settle within
   * the grace before interrupting it. The launch fails with the first reason.
   * A run that has already ended has nothing to stop; its session stays
   * registered until its resources are released, which the caller waits for.
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
        if (yield* Deferred.isDone(active.settled)) {
          yield* Effect.logDebug(
            "The Attempt's run has ended; nothing to stop before its release",
            {
              attemptId,
              worker: active.worker,
              stop: reason,
            },
          );
          return true;
        }
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
    if (
      active === undefined ||
      (yield* Deferred.isDone(active.settled)) ||
      Option.isSome(yield* Ref.get(active.stopping))
    )
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

  const prepared = yield* preparedAttemptsFor(stop, intervene);

  /**
   * Owns an executor's preparation of `request` through `preparedAttemptsFor`.
   * A reattachment that cannot be prepared has its parent task canceled, so
   * the task never runs unobserved and the engine retries on a fresh Attempt.
   */
  const prepare = (
    acquire: Effect.Effect<AcquiredAttempt, ExecutorError, Scope.Scope>,
    request: CheckoutRequest,
  ) =>
    prepared
      .prepare(
        // The first finalizer of the resources scope runs last, so the session
        // stays registered until checkout and credential cleanup finish. Removing
        // it when the launch settled let a second cancel close the scope while
        // the launch was still returning (#197).
        Effect.addFinalizer(() =>
          Effect.sync(() => {
            attempts.delete(request.attemptId);
          }),
        ).pipe(Effect.andThen(acquire)),
        request,
      )
      .pipe(
        Effect.tapError(() =>
          request.reattach
            ? stopTask(request.attemptId, "its reattachment could not be prepared")
            : Effect.void,
        ),
      );

  /**
   * Cancels the Attempt at any stage, then a live parent task this process
   * never launched, such as one still awaiting its reattachment after a restart.
   */
  const cancel = Effect.fn("DurableSession.cancel")(function* (attemptId: AttemptId) {
    yield* Effect.annotateCurrentSpan({ attemptId });
    yield* prepared.cancel(attemptId);
    yield* stopTask(attemptId, "the Attempt was canceled");
  });

  /**
   * Whether a restart reattaches the open Attempt: its parent task still runs,
   * or it reported success and its checkout was not harvested into a recorded result yet.
   */
  const isLive = Effect.fn("DurableSession.isLive")(function* (attemptId: AttemptId) {
    yield* Effect.annotateCurrentSpan({ attemptId });
    if (yield* runtime.isLive(attemptId)) {
      yield* Effect.logDebug("The Attempt's parent task is live", { attemptId });
      return true;
    }
    const finished = yield* runtime.finished(attemptId);
    const unharvested = Option.exists(finished, ({ _tag }) => _tag === "ParentReported");
    yield* Effect.logDebug(
      unharvested
        ? "The Attempt's parent task finished before its checkout was harvested; it is reattached"
        : "The Attempt's parent task is not live",
      { attemptId },
    );
    return unharvested;
  });

  /** The result an Attempt's finished parent task left in durable storage: the recorded harvest, or the parent's failure. */
  const outcome = Effect.fn("DurableSession.outcome")(function* (attemptId: AttemptId) {
    yield* Effect.annotateCurrentSpan({ attemptId });
    const finished = yield* runtime.finished(attemptId);
    const stored = Option.flatMap(
      finished,
      (found): Option.Option<Result.Result<StepResult, AttemptFailure>> =>
        Match.valueTags(found, {
          ParentReported: () => Option.none(),
          ResultRecorded: ({ result }) => Option.some(Result.succeed(result)),
          ParentFailed: ({ failure }) => Option.some(Result.fail(failure)),
        }),
    );
    yield* Effect.logDebug("Read the Attempt's stored outcome", {
      attemptId,
      stored: Option.match(stored, {
        onNone: () => "none",
        onSome: Result.match({ onSuccess: () => "Succeeded", onFailure: ({ _tag }) => _tag }),
      }),
    });
    return stored;
  });

  /**
   * Whether startup recovery must leave `attempt`'s checkout for its
   * reattachment: true when the Attempt is open and `isLive` says a restart
   * reattaches it. A closed Attempt's parent task is canceled here, since
   * nothing reattaches it.
   */
  const awaitsReattach = Effect.fn("DurableSession.awaitsReattach")(function* (
    attempt: AttemptRecovery,
  ) {
    yield* Effect.annotateCurrentSpan({ attemptId: attempt.attemptId, worker: attempt.worker });
    if (!attempt.open) {
      yield* stopTask(attempt.attemptId, "its Attempt is closed");
      return false;
    }
    const live = yield* isLive(attempt.attemptId).pipe(
      Effect.tapError((error) =>
        Effect.logWarning(
          "Could not read whether an open Attempt's parent task is live; reconciling its checkout",
          { attemptId: attempt.attemptId, worker: attempt.worker, message: error.message },
        ),
      ),
      Effect.orElseSucceed(() => false),
    );
    if (live)
      yield* Effect.logInfo("Leaving the checkout of a live Attempt for its reattachment", {
        attemptId: attempt.attemptId,
        worker: attempt.worker,
      });
    return live;
  });

  /** The request a reattached Attempt's parent task was created with; a missing one fails the reattachment. */
  const storedRequest = Effect.fn("DurableSession.storedRequest")(function* (attemptId: AttemptId) {
    yield* Effect.annotateCurrentSpan({ attemptId });
    const stored = yield* runtime.request(attemptId).pipe(
      Effect.mapError(
        (cause) =>
          new ExecutorOperationError({
            operation: "prepare",
            message: "Could not read the reattached Attempt's durable request",
            cause,
          }),
      ),
    );
    if (Option.isNone(stored))
      return yield* new ExecutorOperationError({
        operation: "prepare",
        message: "The reattached Attempt has no durable request",
        cause: new Error(attemptId),
      });
    return stored.value;
  });

  return {
    launch,
    prepare,
    cancel,
    intervene,
    isLive,
    outcome,
    awaitsReattach,
    storedRequest,
  } as const;
});
