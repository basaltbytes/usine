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

/** Why an Attempt's live session is stopping: operator cancel, or a runaway ceiling that tripped. */
export type AttemptStop =
  | { readonly _tag: "Cancel" }
  | { readonly _tag: "Runaway"; readonly ceiling: RunawayCeiling };

/** What an adapter's prepare acquires: the launchable Attempt plus its salvage outcome once released. */
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
 * Tracks each Attempt of one Executor instance from the start of preparation until
 * its resources are released, so `cancel` reaches it at any stage. `stop` stops the
 * Attempt's live session for a reason and reports whether one existed: `cancel` calls
 * it, and so does a tripped wall-clock ceiling before the guard's race interrupts the
 * launch. Without a live session, cancellation releases the Attempt directly. `cancel`,
 * a failed `prepare`, and `launch` each return only after the Attempt's resources are released.
 * `registered` completes once the launch registered the Attempt's live session, so
 * `stop` and `intervene` reach it. `guardSeed` gives what the Attempt's guard goes
 * on from, and `recordUnsupervised` keeps the unsupervised time the guard counted
 * for the seed of the Attempt's reattachment. When `guardSeed` fails, as for a
 * reattachment whose seed cannot be read, the launch releases the Attempt's
 * resources, recording its salvage, and fails with that failure.
 */
export const preparedAttemptsFor = (
  stop: (attemptId: AttemptId, reason: AttemptStop) => Effect.Effect<boolean, ExecutorError>,
  intervene: (
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
      // Preserve the live session's terminal envelope and typed delivery errors.
      // Before registration, scope closure interrupts preparation or process spawn.
      if (!(yield* stop(attemptId, { _tag: "Cancel" }))) {
        yield* Effect.logInfo("Canceling Attempt before its channel is ready", { attemptId });
        yield* active.release(Exit.void);
      } else {
        yield* active.released;
      }
    }, Effect.uninterruptible);

    /** Owns partial preparation and the live session in one child scope, released at the Attempt's end. */
    const prepare = (
      acquire: Effect.Effect<AcquiredAttempt, ExecutorError, Scope.Scope>,
      request: CheckoutRequest,
    ): Effect.Effect<PreparedAttempt, ExecutorError, Scope.Scope> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const scope = yield* Scope.fork(yield* Effect.scope);
          const unavailable = yield* Ref.make(false);
          const released = yield* Deferred.make<void>();
          // Closing a scope that another fiber is already closing returns at once.
          // The owner and a concurrent cancel both wait for the first-registered,
          // last-run finalizer, so neither returns while resources are still held.
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
          // Resources have their own child scope: the supervising fiber's finalizer
          // must stop acquisition before any resources acquired by it are released.
          const resources = yield* Scope.fork(scope);
          const acquiring = yield* Effect.forkIn(Scope.provide(acquire, resources), scope);
          const prepared = yield* restore(Fiber.join(acquiring)).pipe(
            Effect.onError((cause) => release(Exit.failCause(cause))),
          );

          /** Releases the Attempt's resources, then fails when its salvage could not be recorded. */
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
                  cause: new Error("prepared Attempt is no longer available"),
                });
              }
              // A seed that cannot be read ends the Attempt before its launch: its
              // checkout is salvaged and the salvage recorded, so the Run's next
              // Attempt starts from it. The Attempt fails with the seed's failure
              // first, then any salvage that could not be recorded. An interrupt,
              // as when this process stops, leaves the checkout to the owner's scope.
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
                    intervene(
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
              // The clock starts once the launch registered the session `stop` reaches.
              // A remote launch first waits for its Worker's liveness watch, which the
              // Attempts reattached on that Worker after a restart contend for; a seed
              // that leaves no time would trip meanwhile, find no session to stop,
              // and leave the reattached parent task running.
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
              // Closing the owner's scope interrupts the session before checkout and
              // credential finalizers. Interrupting a caller waiting on join must also
              // stop that scoped fiber, so timeout/cancel completes the handshake first.
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
