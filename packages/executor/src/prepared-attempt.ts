import type { AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { type AttemptFailure, InfraFailure } from "@usine/core/attempt/failure";
import { Deferred, Effect, Exit, Fiber, Ref, Scope } from "effect";
import type { CheckoutRequest, ExecutorError, PreparedAttempt } from "./executor.ts";
import { withAttemptGuard } from "./guard.ts";
import type { ProvisionedWorktree } from "./provision.ts";

/** What an adapter's prepare acquires: the launchable Attempt plus its salvage outcome once released. */
export interface AcquiredAttempt extends PreparedAttempt {
  readonly salvaged: ProvisionedWorktree["salvaged"];
  readonly recordSalvage: ProvisionedWorktree["recordSalvage"];
}

interface OwnedAttempt {
  readonly unavailable: Ref.Ref<boolean>;
  /** Closes the Attempt's scope and returns once every resource is released. */
  readonly release: (exit: Exit.Exit<unknown, unknown>) => Effect.Effect<void>;
}

/**
 * Tracks each Attempt of one Executor instance from the start of preparation until
 * its resources are released, so `cancel` reaches it at any stage. `cancelLive`
 * delivers Cancel through the Attempt's live channel and reports whether one existed;
 * without one, cancellation releases the Attempt directly. `cancel`, a failed
 * `prepare`, and `launch` each return only after the Attempt's resources are released.
 */
export const preparedAttemptsFor = (
  cancelLive: (attemptId: AttemptId) => Effect.Effect<boolean, ExecutorError>,
  intervene: (
    attemptId: AttemptId,
    intervention: AttemptChannel.Intervention,
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
      // Preserve the live channel's terminal envelope and typed delivery errors.
      // Before registration, scope closure interrupts preparation or process spawn.
      if (!(yield* cancelLive(attemptId))) {
        yield* Effect.logInfo("Canceling Attempt before its channel is ready", { attemptId });
        yield* active.release(Exit.void);
      }
    }, Effect.uninterruptible);

    /** Owns partial preparation and the run host in one child scope, released at the Attempt's end. */
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
          attempts.set(request.attemptId, { unavailable, release });
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
              const warn = (message: string) =>
                intervene(
                  attemptId,
                  new AttemptChannel.Intervention({
                    operator: "engine",
                    target: new AttemptChannel.ParentTarget(),
                    action: new AttemptChannel.Steer({ message }),
                  }),
                );
              const limits = {
                attemptId,
                maxAttemptMinutes: request.maxAttemptMinutes,
                maxAttemptTokens: request.maxAttemptTokens,
                warn,
              };
              yield* prepared.recordSalvage(io.salvage);
              // Closing the owner's scope interrupts the session before checkout and
              // credential finalizers. Interrupting a caller waiting on join must also
              // stop that scoped fiber, so timeout/cancel completes the handshake first.
              return yield* Effect.acquireUseRelease(
                Effect.forkIn(withAttemptGuard(limits, io, prepared.launch), scope),
                Fiber.join,
                Fiber.interrupt,
              ).pipe(
                Effect.onExit((exit) =>
                  release(exit).pipe(Effect.andThen(Effect.asVoid(prepared.salvaged))),
                ),
              );
            }),
          } satisfies PreparedAttempt;
        }),
      );

    return { prepare, cancel };
  });
