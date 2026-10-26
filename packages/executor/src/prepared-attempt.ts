import type { AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import {
  type AttemptFailure,
  InfraFailure,
  type RunawayCeiling,
} from "@usine/core/attempt/failure";
import { Cause, Deferred, type Duration, Effect, Exit, Fiber, Ref, Scope } from "effect";
import type { CheckoutRequest, ExecutorError, PreparedAttempt } from "./executor.ts";
import { attemptGuard, type AttemptGuardSeed } from "./guard.ts";
import type { ProvisionedWorktree } from "./provision.ts";

export type AttemptStop =
  | { readonly _tag: "Cancel" }
  | { readonly _tag: "Runaway"; readonly ceiling: RunawayCeiling }
  /**
   * The Worker is losing the Attempt's machine, such as a sandbox whose host the platform
   * restarts. The Attempt fails with a retryable `InfraFailure` carrying `message`.
   */
  | { readonly _tag: "Drain"; readonly message: string };

/** The result of an executor's `acquire`: the prepared Attempt and its salvage handles. */
export interface AcquiredAttempt extends PreparedAttempt {
  readonly salvaged: ProvisionedWorktree["salvaged"];
  readonly recordSalvage: ProvisionedWorktree["recordSalvage"];
}

interface OwnedAttempt {
  readonly unavailable: Ref.Ref<boolean>;
  readonly released: Effect.Effect<void>;
  /** Closes the Attempt's scope and returns once every resource is released. */
  readonly release: (exit: Exit.Exit<unknown, unknown>) => Effect.Effect<void>;
}

/**
 * Returns `prepare` and `cancel` for one executor's Attempts, tracked from preparation until
 * release so `cancel` works at any stage. `cancel`, a failed `prepare`, and `launch` each return
 * only after the Attempt's resources are released.
 *
 * - `stop`: stops the live session and returns whether one existed.
 * - `registered`: completes when the launch registers the live session.
 * - `warnParent`: sends the guard's warning steer; can wait for the parent's channel.
 * - `guardSeed`: returns the guard's initial state. If it fails, the launch records salvage,
 *   releases the resources, and fails.
 * - `recordUnsupervised`: persists the guard's unsupervised time for a later reattachment.
 */
export const preparedAttemptsFor = (
  stop: (attemptId: AttemptId, reason: AttemptStop) => Effect.Effect<boolean, ExecutorError>,
  warnParent: (
    attemptId: AttemptId,
    intervention: AttemptChannel.Intervention,
  ) => Effect.Effect<void, AttemptFailure>,
  registered: (attemptId: AttemptId) => Effect.Effect<void>,
  guardSeed: (
    request: CheckoutRequest,
    io: AttemptChannel.Sink,
  ) => Effect.Effect<AttemptGuardSeed, InfraFailure>,
  recordUnsupervised: (
    attemptId: AttemptId,
    unsupervised: Duration.Duration,
  ) => Effect.Effect<void, AttemptFailure>,
) =>
  Effect.sync(() => {
    const attempts = new Map<AttemptId, OwnedAttempt>();
    const cancel = Effect.fn("PreparedAttempt.cancel")(function* (attemptId: AttemptId) {
      yield* Effect.annotateCurrentSpan({ attemptId });
      const active = attempts.get(attemptId);
      if (active === undefined) {
        yield* Effect.logDebug("Attempt cancellation was a no-op", { attemptId });
        return;
      }
      yield* Ref.set(active.unavailable, true);
      // With a live session, stops it so its terminal envelope and typed errors are kept. Before
      // registration, closing the scope interrupts preparation or process spawn.
      if (!(yield* stop(attemptId, { _tag: "Cancel" }))) {
        yield* Effect.logInfo("Canceling Attempt before its channel is ready", { attemptId });
        yield* active.release(Exit.void);
      } else {
        yield* active.released;
      }
    }, Effect.uninterruptible);

    /** Runs preparation and the live session in one child scope that closes when the Attempt ends. */
    const prepare = (
      acquire: Effect.Effect<AcquiredAttempt, ExecutorError, Scope.Scope>,
      request: CheckoutRequest,
    ): Effect.Effect<PreparedAttempt, ExecutorError, Scope.Scope> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const scope = yield* Scope.fork(yield* Effect.scope);
          const unavailable = yield* Ref.make(false);
          const released = yield* Deferred.make<void>();
          // Scope.close returns immediately when another fiber is already closing the scope, so the
          // owner and a concurrent cancel both wait for `released`, set by the first-registered
          // (last-run) finalizer.
          const release: OwnedAttempt["release"] = (exit) =>
            Scope.close(scope, exit).pipe(Effect.andThen(Deferred.await(released)));
          attempts.set(request.attemptId, {
            unavailable,
            release,
            released: Deferred.await(released),
          });
          yield* Scope.addFinalizer(
            scope,
            Effect.suspend(() => {
              attempts.delete(request.attemptId);
              return Deferred.succeed(released, undefined);
            }),
          );
          yield* Scope.addFinalizer(scope, Ref.set(unavailable, true));
          // A separate child scope, so the acquiring fiber is interrupted before its resources are
          // released.
          const resources = yield* Scope.fork(scope);
          const acquiring = yield* Effect.forkIn(Scope.provide(acquire, resources), scope);
          const prepared = yield* restore(Fiber.join(acquiring)).pipe(
            Effect.onError((cause) => release(Exit.failCause(cause))),
          );

          /** Releases the Attempt's resources, then fails if its salvage couldn't be recorded. */
          const releaseSalvaged = (exit: Exit.Exit<unknown, unknown>) =>
            release(exit).pipe(Effect.andThen(Effect.asVoid(prepared.salvaged)));

          return {
            workspace: prepared.workspace,
            launch: Effect.fn("PreparedAttempt.launch")(function* (io) {
              const attemptId = prepared.workspace.spec.attemptId;
              yield* Effect.annotateCurrentSpan({ attemptId, worker: prepared.workspace.worker });
              if (yield* Ref.getAndSet(unavailable, true)) {
                yield* Effect.logWarning("Attempt was already launched or released", { attemptId });
                return yield* new InfraFailure({
                  message: `Attempt ${attemptId} was already launched or released`,
                  cause: new Error("prepared attempt is no longer available"),
                });
              }
              // If the seed can't be read, records salvage and releases the checkout without launching, so
              // the Run's next Attempt starts from it. On interruption, such as process shutdown, the
              // owner's scope handles the checkout.
              const seed = yield* guardSeed(request, io).pipe(
                Effect.onExit((exit) =>
                  Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)
                    ? Effect.void
                    : Effect.logWarning(
                        "The Attempt's runaway guard cannot start; releasing its checkout without launching it",
                        { attemptId },
                      ).pipe(
                        Effect.andThen(prepared.recordSalvage(io.salvage)),
                        Effect.andThen(releaseSalvaged(exit)),
                      ),
                ),
              );
              const guard = yield* attemptGuard(
                {
                  attemptId,
                  maxAttemptMinutes: request.maxAttemptMinutes,
                  maxAttemptTokens: request.maxAttemptTokens,
                  warn: (message) =>
                    warnParent(
                      attemptId,
                      new AttemptChannel.Intervention({
                        operator: "engine",
                        target: new AttemptChannel.ParentTarget(),
                        action: new AttemptChannel.Steer({ message }),
                      }),
                    ),
                  recordUnsupervised: (unsupervised) => recordUnsupervised(attemptId, unsupervised),
                },
                io,
                seed,
              );
              // Starts the clock only after the launch registers its session. A remote launch first waits
              // for the Worker's liveness watch, and a seed with no time left could trip before there's a
              // session to stop.
              const tripped = registered(attemptId).pipe(
                Effect.andThen(guard.tripped),
                Effect.tapError(({ ceiling }) =>
                  stop(attemptId, { _tag: "Runaway", ceiling }).pipe(
                    Effect.tapError((error) =>
                      Effect.logWarning("Could not stop the runaway Attempt", {
                        attemptId,
                        ceiling,
                        errorTag: error._tag,
                      }),
                    ),
                    Effect.ignore,
                  ),
                ),
              );
              yield* prepared.recordSalvage(io.salvage);
              // Closing the owner's scope interrupts the session before the checkout and credential
              // finalizers. acquireUseRelease interrupts the forked fiber when the caller waiting on join
              // is interrupted.
              return yield* Effect.acquireUseRelease(
                Effect.forkIn(Effect.raceFirst(prepared.launch(guard.sink), tripped), scope),
                Fiber.join,
                Fiber.interrupt,
              ).pipe(Effect.onExit((exit) => releaseSalvaged(exit)));
            }),
          } satisfies PreparedAttempt;
        }),
      );

    return { prepare, cancel };
  });
