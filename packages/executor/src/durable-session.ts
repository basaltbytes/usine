import { keyedLockFor } from "./keyed-lock.ts";
import type { ChildHost } from "@usine/agents/child-host";
import type { AttemptId, StopReason } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import {
  AgentFailure,
  type AttemptFailure,
  InfraFailure,
  RunawayFailure,
} from "@usine/core/attempt/failure";
import type { AttemptRecovery, RecoverySink } from "@usine/core/attempt/salvage";
import type { GatewayCredentialKind, MachineId } from "@usine/core/worker";
import type { AttemptWindowsRead, HarvestSpec } from "@usine/core/step/harvest";
import type { Comment, StepResult, StepResultFact } from "@usine/core/step/result";
import {
  type AttemptReport,
  AttemptRequest,
  AttemptRuntime,
  harvestedResult,
} from "@usine/durable/attempt-runtime";
import {
  Cause,
  Deferred,
  Duration,
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
import { guardSeed } from "./guard.ts";
import { type AcquiredAttempt, type AttemptStop, preparedAttemptsFor } from "./prepared-attempt.ts";

interface ActiveAttempt {
  readonly worker: AttemptWorkspace["worker"];
  /** The launch scope. Intervention deliveries fork into it so their caller can't interrupt them. */
  readonly scope: Scope.Scope;
  /** The reason the Attempt is stopping; only the first is kept. */
  readonly stopping: Ref.Ref<Option.Option<AttemptStop>>;
  /** The running `execute` fiber, interrupted when a stop's grace period expires. */
  readonly execution: Ref.Ref<Option.Option<Fiber.Fiber<AttemptReport, AttemptFailure>>>;
  /** Completes when the run ends. After that, `stop` does nothing and `intervene` fails with `AgentFailure`. */
  readonly settled: Deferred.Deferred<void>;
}

export interface DurableCheckout {
  /** The host with the checkout, where the children run. */
  readonly host: ChildHost;
  /**
   * The provider's ID of the machine that a provisioned Worker created for the Attempt, or `None`
   * on other Workers.
   */
  readonly machine: Option.Option<MachineId>;
  /** The complete environment for the children and harvesting commands (ADR 0011). */
  readonly environment: Record<string, string>;
  /**
   * Returns the credential kind the Gateway injects for the children, from the Worker's latest
   * preflight. Returns `None` if the children use their harness's own login.
   */
  readonly gatewayCredential: Effect.Effect<Option.Option<GatewayCredentialKind>>;
  /**
   * Returns the checkout's commits and pull requests, and the comments the Attempt posted on its
   * Item within its own window and outside the windows of the Agent's other Attempts. Reads
   * `windows` after GitHub lists the comments, and fails if they can't be read.
   */
  readonly harvest: (
    windows: AttemptWindowsRead<AttemptFailure>,
  ) => Effect.Effect<ReadonlyArray<StepResultFact>, AttemptFailure>;
  /**
   * Returns only the comments, filtered as in `harvest`, for an unsuccessful Attempt. Returns none
   * if GitHub fails or the windows can't be read.
   */
  readonly harvestComments: (
    windows: AttemptWindowsRead<AttemptFailure>,
  ) => Effect.Effect<ReadonlyArray<Comment>>;
  /** Harvests a kept checkout with a fresh credential after its launch scope has closed. */
  readonly harvestKeptComments: (
    windows: AttemptWindowsRead<AttemptFailure>,
  ) => Effect.Effect<ReadonlyArray<Comment>, ExecutorError>;
  /** Keeps the checkout on disk so a restart can reattach the parent or repeat an unrecorded harvest. */
  readonly keepForReattach: Effect.Effect<void>;
  /**
   * Keeps the checkout on disk, without salvage, while the parent task may still run in it.
   * `reconcileKept` salvages it once a stop is confirmed.
   */
  readonly keepUntilStopped: Effect.Effect<void>;
  /**
   * Salvages the checkout that `keepUntilStopped` kept with a new credential, records the salvage
   * through `record`, and removes the checkout once its work is pushed. Does nothing if the
   * checkout is gone.
   */
  readonly reconcileKept: (
    record: AttemptChannel.Sink["salvage"],
  ) => Effect.Effect<void, ExecutorError | AttemptFailure>;
}

/**
 * A function that returns the comments the Attempt described by `spec` posted on its Item, read
 * from its checkout with a new credential and filtered by `windows`. Fails only if the
 * credential can't be acquired.
 */
export type PostedCommentsHarvest = <W>(
  spec: HarvestSpec,
  windows: AttemptWindowsRead<W>,
) => Effect.Effect<ReadonlyArray<Comment>, ExecutorError>;

export interface DurableSessionOptions {
  /** The timeout for each cancellation stage: the parent task's abort, then the Attempt's end. */
  readonly interruptGrace: Parameters<typeof Effect.timeoutOption>[1];
}

const cancelError = (attemptId: AttemptId, cause: unknown) =>
  new ExecutorOperationError({
    operation: "cancel",
    message: `Can't cancel attempt ${attemptId}`,
    cause,
  });

/** The reason that the log of each engine-requested stop gives. */
const stopReasons = {
  cancel: "the Attempt was canceled",
  failed: "the Attempt failed",
  startup: "a restart found the Attempt closed or not reattached",
} as const satisfies Record<StopReason, string>;

/**
 * Returns the session that runs Attempts whose Pi parent is a durable task in this process
 * (`AttemptRuntime`), for every Worker kind. If a launch is interrupted without a stop, the
 * parent task stays live and the checkout stays on disk for reattachment after restart; every
 * other ending stops the parent task. If that stop can't be confirmed, the checkout stays on disk
 * until a `cancel` confirms it (#523).
 */
export const durableSessionFor = Effect.fn("DurableSession.for")(function* (
  options: DurableSessionOptions,
) {
  const runtime = yield* AttemptRuntime;
  const attempts = new Map<AttemptId, ActiveAttempt>();
  const cancellations = yield* keyedLockFor<AttemptId>();
  /**
   * The reconciliation of each checkout kept while its parent task isn't confirmed stopped, by
   * Attempt. The `cancel` that confirms the stop runs it.
   */
  const unstopped = new Map<AttemptId, Effect.Effect<void>>();
  /** Completed by each launch after it adds its Attempt to `attempts`. */
  const registrations = new Map<AttemptId, Deferred.Deferred<void>>();
  const registration = (attemptId: AttemptId) => {
    const existing = registrations.get(attemptId);
    if (existing !== undefined) return existing;
    const created = Deferred.makeUnsafe<void>();
    registrations.set(attemptId, created);
    return created;
  };

  /**
   * Cancels a live parent task, then settles its record unless draining. Fails with a `cancel`
   * `ExecutorOperationError` if liveness can't be read, cancellation fails or exceeds
   * `interruptGrace`, or settlement fails.
   */
  const stopTask = Effect.fn("DurableSession.stopTask")(function* (
    attemptId: AttemptId,
    reason: string,
    disposition: "settle" | "drain" = "settle",
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
      return yield* cancelError(attemptId, live.failure);
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
    if (Result.isFailure(canceled)) {
      yield* Effect.logWarning("The Attempt's parent task could not be canceled", {
        attemptId,
        reason,
        errorTag: canceled.failure._tag,
        message: canceled.failure.message,
      });
      return yield* cancelError(attemptId, canceled.failure);
    }
    if (Option.isNone(canceled.success)) {
      yield* Effect.logWarning("Canceling the Attempt's parent task exceeded the interrupt grace", {
        attemptId,
        reason,
      });
      return yield* cancelError(
        attemptId,
        new Error("canceling the parent task exceeded the interrupt grace"),
      );
    }
    if (disposition === "settle")
      yield* runtime.settle(attemptId).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Could not settle the stopped attempt", {
            attemptId,
            reason,
            errorTag: error._tag,
            message: error.message,
          }),
        ),
        Effect.mapError((error) => cancelError(attemptId, error)),
      );
    else
      yield* Effect.logDebug("The drained attempt's record stays unsettled", { attemptId, reason });
  });

  /** Calls `record` with `comments`; failures are logged, not raised. */
  const recordComments = Effect.fn("DurableSession.recordComments")(function* <E>(
    attemptId: AttemptId,
    comments: ReadonlyArray<Comment>,
    record: (comments: ReadonlyArray<Comment>) => Effect.Effect<void, E>,
  ) {
    yield* Effect.annotateCurrentSpan({ attemptId, comments: comments.length });
    if (comments.length === 0) {
      yield* Effect.logDebug("The Attempt posted no comment on its Item before it ended", {
        attemptId,
      });
      return;
    }
    yield* record(comments).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Could not record the comments the Attempt posted before it ended", {
          attemptId,
          comments: comments.length,
          message: String(error),
        }),
      ),
      Effect.ignore,
    );
  });

  /**
   * Records the comments and reviews an unsuccessful Attempt posted on its Run's Item, after its
   * parent task stops. A canceled Attempt's window ends when the orchestrator closes it, so later
   * comments are excluded. Failures are logged without changing the Attempt's result.
   */
  const recordPostedComments = Effect.fn("DurableSession.recordPostedComments")(function* (
    attemptId: AttemptId,
    checkout: DurableCheckout,
    io: AttemptChannel.Sink,
  ) {
    yield* Effect.annotateCurrentSpan({ attemptId });
    yield* recordComments(attemptId, yield* checkout.harvestComments(io.windows), io.comments);
  });

  /**
   * Keeps the checkout of an Attempt whose parent task may still run in it, so neither salvage nor
   * removal runs under the task, and registers its reconciliation for the `cancel` that confirms
   * the stop (#523).
   */
  const keepUntilStopped = Effect.fn("DurableSession.keepUntilStopped")(function* (
    attemptId: AttemptId,
    worker: AttemptWorkspace["worker"],
    checkout: DurableCheckout,
    io: AttemptChannel.Sink,
  ) {
    const fields = { attemptId, worker };
    yield* Effect.annotateCurrentSpan(fields);
    yield* checkout.keepUntilStopped;
    unstopped.set(
      attemptId,
      checkout.harvestKeptComments(io.windows).pipe(
        Effect.flatMap((comments) => recordComments(attemptId, comments, io.comments)),
        Effect.tapError((error) =>
          Effect.logWarning(
            "Could not acquire a credential to harvest the kept checkout's comments",
            {
              ...fields,
              errorTag: error._tag,
              message: error.message,
            },
          ),
        ),
        Effect.ignore,
        Effect.andThen(checkout.reconcileKept(io.salvage)),
        Effect.tap(() =>
          Effect.logInfo(
            "Reconciled the checkout kept while the Attempt's parent task was not confirmed stopped",
            fields,
          ),
        ),
        Effect.tapError((error) =>
          Effect.logError(
            "Could not reconcile the checkout kept while the Attempt's parent task was not confirmed stopped; the checkout stays until the next start reconciles it",
            { ...fields, errorTag: error._tag, message: String(error) },
          ),
        ),
        Effect.ignore,
      ),
    );
    yield* Effect.logWarning(
      "The Attempt's parent task may still run in its checkout; the checkout stays, without salvage, until a stop is confirmed",
      fields,
    );
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
      yield* Deferred.succeed(registration(attemptId), undefined);
      yield* Effect.logInfo("Running the Attempt's parent task", {
        attemptId,
        worker: prepared.worker,
        worktree: prepared.worktree,
        childHost: checkout.host._tag,
        gatewayCredential: Option.getOrElse(yield* checkout.gatewayCredential, () => "none"),
      });
      const running = yield* runtime
        .execute(
          new AttemptRequest({
            spec,
            worker: prepared.worker,
            cwd: prepared.worktree,
            host: checkout.host,
            machine: checkout.machine,
            environment: checkout.environment,
            gatewayCredential: checkout.gatewayCredential,
          }),
          io,
        )
        .pipe(Effect.forkScoped);
      yield* Ref.set(execution, Option.some(running));
      const executed = yield* Fiber.await(running);
      const stop = yield* Ref.get(stopping);
      if (Option.isSome(stop) && stop.value._tag === "Runaway")
        return yield* new RunawayFailure({ ceiling: stop.value.ceiling });
      if (Option.isSome(stop) && stop.value._tag === "Drain")
        return yield* new InfraFailure({
          message: stop.value.message,
          cause: new Error(stop.value.message),
        });
      if (
        Option.isSome(stop) &&
        Exit.isFailure(executed) &&
        Cause.hasInterruptsOnly(executed.cause)
      )
        return yield* new AgentFailure({ message: "The attempt's parent task was canceled" });
      const report = yield* executed;
      // Reads the windows after GitHub lists the comments, because a later Attempt of the same Agent
      // can overlap this one and a cancel can close this window first (#429). A failed read fails
      // the Attempt.
      const facts = yield* checkout.harvest(io.windows);
      const harvested = harvestedResult(report, facts);
      if (Result.isFailure(harvested)) {
        yield* Effect.logWarning(
          "The parent's last turn answered the operator and the checkout holds no facts; the Attempt fails",
          { attemptId },
        );
        return yield* harvested.failure;
      }
      const result = harvested.success;
      yield* Effect.logInfo("The Attempt's parent task finished", {
        attemptId,
        facts: result.facts.length,
        answeredOperator: report.answeredOperator,
      });
      yield* runtime.recordResult(attemptId, result).pipe(
        Effect.tapError((error) =>
          Effect.logWarning(
            "Could not record the Attempt's result in durable storage; preserving the checkout for reattachment",
            { attemptId, errorTag: error._tag, message: error.message },
          ).pipe(Effect.andThen(checkout.keepForReattach)),
        ),
        Effect.ignore,
      );
      return result;
    });
    return yield* Effect.scoped(run).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          // Complete `settled` first so `stopping` cannot change while the branches below read it.
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
              // stopTask logs its own failure; the Attempt's result is unchanged. The engine then
              // confirms the stop through `cancel` before it frees the Worker slot.
              const stopped = yield* stopTask(
                attemptId,
                Option.match(stop, {
                  onNone: () => stopReasons.failed,
                  onSome: (reason) =>
                    Match.valueTags(reason, {
                      Cancel: () => stopReasons.cancel,
                      Runaway: () => "a ceiling tripped",
                      Drain: () => "the Worker is losing the Attempt's machine",
                    }),
                }),
                Option.exists(stop, ({ _tag }) => _tag === "Drain") ? "drain" : "settle",
              ).pipe(Effect.result);
              if (Result.isFailure(stopped))
                yield* keepUntilStopped(attemptId, prepared.worker, checkout, io);
              yield* recordPostedComments(attemptId, checkout, io);
            }
          }
        }),
      ),
    );
  });

  /**
   * Stops a launched Attempt for `reason` and returns whether one was running here. Cancels the
   * parent task, then waits up to `interruptGrace` before interrupting the Attempt; the launch
   * fails with the first reason. For a run that already ended, does nothing, and the caller waits
   * for its resources to be released.
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
        message: "This attempt has no live session in this orchestrator",
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
      // Forks into the Attempt's scope so a disconnected HTTP caller doesn't interrupt delivery.
      Effect.forkIn(active.scope),
      Effect.flatMap(Fiber.join),
    );
  });

  /**
   * Sends the runaway guard's warning steer through `intervene` after `execute` attaches to the
   * Attempt's channel. The guard starts before `execute` reads durable storage, so sending
   * immediately would drop a warning restored on reattachment (#178).
   */
  const warnParent = Effect.fn("DurableSession.warnParent")(function* (
    attemptId: AttemptId,
    intervention: AttemptChannel.Intervention,
  ) {
    yield* Effect.annotateCurrentSpan({ attemptId });
    yield* runtime.attached(attemptId);
    yield* intervene(attemptId, intervention);
  });

  /**
   * Wraps `read`, one `part` of the guard's restored state. If `read` fails after the store's
   * retries, stops the parent task and fails the reattachment with an `InfraFailure` for `part`,
   * because restarting that part would reset the Attempt's allowance (#178).
   */
  const seedPart =
    (attemptId: AttemptId, part: string) =>
    <A>(read: Effect.Effect<A, AttemptFailure>): Effect.Effect<A, InfraFailure> =>
      read.pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* Effect.logError(
              `Could not read the reattached Attempt's ${part}; the reattachment fails instead of starting its runaway guard over`,
              { attemptId, part, errorTag: error._tag, message: error.message },
            );
            yield* stopTask(attemptId, `its runaway guard cannot read the Attempt's ${part}`).pipe(
              Effect.ignore,
            );
            return yield* new InfraFailure({
              message: `Can't read the ${part} of the reattached attempt, which the runaway guard needs to resume`,
              cause: error,
            });
          }),
        ),
      );

  /**
   * Returns the initial runaway guard state for `request`, empty for a new Attempt. On
   * reattachment, reads the transcript if any ceiling is set and the unsupervised time if
   * `maxAttemptMinutes` is set. Fails with an `InfraFailure` after stopping the parent task if a
   * read fails.
   */
  const guardSeedFor = Effect.fn("DurableSession.guardSeed")(function* (
    request: CheckoutRequest,
    io: AttemptChannel.Sink,
  ) {
    const attemptId = request.attemptId;
    const wallClock = Option.isSome(request.maxAttemptMinutes);
    const armed = wallClock || Option.isSome(request.maxAttemptTokens);
    yield* Effect.annotateCurrentSpan({ attemptId, reattach: request.reattach, armed });
    if (!request.reattach) return guardSeed([], Duration.zero);
    if (!armed) {
      yield* Effect.logDebug("The reattached Attempt arms no ceiling; its guard resumes nothing", {
        attemptId,
      });
      return guardSeed([], Duration.zero);
    }
    const transcript = yield* io.transcript.pipe(seedPart(attemptId, "transcript"));
    const recorded = wallClock
      ? yield* runtime.unsupervised(attemptId).pipe(seedPart(attemptId, "unsupervised time"))
      : Option.none<Duration.Duration>();
    const seed = guardSeed(
      transcript,
      Option.getOrElse(recorded, () => Duration.zero),
    );
    yield* Effect.logInfo("Resuming the reattached Attempt's ceilings", {
      attemptId,
      envelopes: transcript.length,
      tokens: [...seed.tokens.values()].reduce((sum, value) => sum + value, 0),
      unsupervisedRecorded: Option.isSome(recorded),
      unsupervisedMinutes: Math.round(Duration.toMillis(seed.unsupervised) / 6_000) / 10,
      parentHeld: seed.parentHeld,
      warned: [...seed.warned],
    });
    return seed;
  });

  const prepared = yield* preparedAttemptsFor(
    stop,
    warnParent,
    (attemptId) => Deferred.await(registration(attemptId)),
    guardSeedFor,
    runtime.recordUnsupervised,
  );

  /**
   * Wraps an executor's `acquire` with `preparedAttemptsFor`. If a reattachment can't be prepared,
   * cancels its parent task so the engine retries on a new Attempt.
   */
  const prepare = (
    acquire: Effect.Effect<AcquiredAttempt, ExecutorError, Scope.Scope>,
    request: CheckoutRequest,
  ) =>
    prepared
      .prepare(
        // Added first so it runs last: the session stays registered until checkout and credential
        // cleanup finish (#197).
        Effect.addFinalizer(() =>
          Effect.sync(() => {
            attempts.delete(request.attemptId);
            registrations.delete(request.attemptId);
          }),
        ).pipe(Effect.andThen(acquire)),
        request,
      )
      .pipe(
        Effect.tapError(() =>
          request.reattach
            ? // stopTask logs its own failure; the preparation error is returned.
              stopTask(request.attemptId, "its reattachment could not be prepared").pipe(
                Effect.ignore,
              )
            : Effect.void,
        ),
      );

  /**
   * Stops the launched Attempt because the Worker is losing its machine, such as a sandbox whose
   * host the platform restarts. The launch fails with a retryable `InfraFailure` with `message`,
   * and its release salvages the checkout, so the next Attempt resumes from the salvage. Returns
   * whether the Attempt ran here.
   */
  const drain = Effect.fn("DurableSession.drain")(function* (
    attemptId: AttemptId,
    message: string,
  ) {
    yield* Effect.annotateCurrentSpan({ attemptId });
    yield* Effect.logWarning("Draining the Attempt before the Worker loses its machine", {
      attemptId,
      message,
    });
    return yield* stop(attemptId, { _tag: "Drain", message });
  });

  /**
   * Cancels the Attempt at any stage, then stops a live parent task this process didn't launch,
   * for example one awaiting reattachment. Fails if that task can't be confirmed stopped. Once it
   * is, reconciles the checkout that a launch kept while the stop was unconfirmed.
   */
  const cancel = Effect.fn("DurableSession.cancel")(
    function* (attemptId: AttemptId, reason: StopReason) {
      yield* Effect.annotateCurrentSpan({ attemptId, reason });
      yield* prepared.cancel(attemptId);
      yield* stopTask(attemptId, stopReasons[reason]);
      const kept = unstopped.get(attemptId);
      if (kept === undefined) return;
      unstopped.delete(attemptId);
      yield* Effect.logInfo(
        "The Attempt's parent task is confirmed stopped; reconciling the checkout kept while it was not",
        { attemptId, reason },
      );
      yield* kept;
    },
    (effect, attemptId) => effect.pipe(cancellations.withLock(attemptId)),
  );

  /**
   * Returns whether the open Attempt's parent task is running or reported success without a
   * recorded harvest. If true, a restart reattaches it.
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

  /** Returns the stored result of a finished parent task: the recorded harvest or the parent's failure. */
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
   * Stops `attempt`'s parent task before recovery reconciles its checkout, even if `isLive` returns
   * true. An unharvested report stays unharvested while the checkout is salvaged (#180). Fails if
   * the task can't be confirmed stopped.
   */
  const stopForRecovery = Effect.fn("DurableSession.stopForRecovery")(function* (
    attempt: AttemptRecovery,
  ) {
    yield* Effect.annotateCurrentSpan({ attemptId: attempt.attemptId, worker: attempt.worker });
    yield* stopTask(
      attempt.attemptId,
      attempt.open ? "its Run does not reattach the Attempt" : "its Attempt is closed",
    );
  });

  /**
   * During startup reconciliation, records the comments and reviews an open Attempt posted on its
   * Run's Item if durable storage has its parent's failure. `harvest` is `None` if the checkout is
   * gone. Does nothing for other Attempts; failures are logged, not raised.
   */
  const recoverPostedComments = Effect.fn("DurableSession.recoverPostedComments")(function* <E>(
    attempt: AttemptRecovery,
    harvest: Option.Option<PostedCommentsHarvest>,
    record: Pick<RecoverySink<E>, "comments" | "windows">,
  ) {
    if (!attempt.open) return;
    const { attemptId, worker } = attempt;
    yield* Effect.annotateCurrentSpan({ attemptId, worker });
    const finished = yield* runtime.finished(attemptId).pipe(Effect.result);
    if (Result.isFailure(finished)) {
      yield* Effect.logWarning(
        "Could not read how the open Attempt's parent task ended; the comments it posted are not recorded",
        { attemptId, worker, errorTag: finished.failure._tag, message: finished.failure.message },
      );
      return;
    }
    if (!Option.exists(finished.success, ({ _tag }) => _tag === "ParentFailed")) {
      yield* Effect.logDebug(
        "Durable storage holds no failure of the open Attempt's parent task; reconciliation records no comment",
        {
          attemptId,
          worker,
          finished: Option.match(finished.success, {
            onNone: () => "none",
            onSome: ({ _tag }) => _tag,
          }),
        },
      );
      return;
    }
    if (Option.isNone(harvest)) {
      yield* Effect.logWarning(
        "The open Attempt's parent task failed and its checkout is gone; the comments it posted are not recorded",
        { attemptId, worker },
      );
      return;
    }
    const stored = yield* runtime.request(attemptId).pipe(Effect.result);
    if (Result.isFailure(stored) || Option.isNone(stored.success)) {
      yield* Effect.logWarning(
        "The open Attempt's parent task failed and its durable request cannot be read; the comments it posted are not recorded",
        {
          attemptId,
          worker,
          message: Result.isFailure(stored) ? stored.failure.message : "no durable request",
        },
      );
      return;
    }
    yield* Effect.logInfo(
      "The open Attempt's parent task failed before this process recorded it; harvesting the comments it posted from its checkout",
      { attemptId, worker },
    );
    const comments = yield* harvest
      .value(stored.success.value.spec, record.windows)
      .pipe(Effect.result);
    if (Result.isFailure(comments)) {
      yield* Effect.logWarning(
        "Could not acquire a credential to harvest the open Attempt's comments; the comments it posted are not recorded",
        { attemptId, worker, errorTag: comments.failure._tag, message: comments.failure.message },
      );
      return;
    }
    yield* recordComments(attemptId, comments.success, record.comments);
  });

  /** Returns the request the reattached Attempt's parent task was created with. Fails with a `prepare` `ExecutorOperationError` if it's missing or unreadable. */
  const storedRequest = Effect.fn("DurableSession.storedRequest")(function* (attemptId: AttemptId) {
    yield* Effect.annotateCurrentSpan({ attemptId });
    const stored = yield* runtime.request(attemptId).pipe(
      Effect.mapError(
        (cause) =>
          new ExecutorOperationError({
            operation: "prepare",
            message: "Can't read the durable request of the reattached attempt",
            cause,
          }),
      ),
    );
    if (Option.isNone(stored))
      return yield* new ExecutorOperationError({
        operation: "prepare",
        message: "The reattached attempt has no durable request",
        cause: new Error(attemptId),
      });
    return stored.value;
  });

  return {
    launch,
    prepare,
    cancel,
    drain,
    intervene,
    isLive,
    outcome,
    stopForRecovery,
    recoverPostedComments,
    storedRequest,
  } as const;
});
