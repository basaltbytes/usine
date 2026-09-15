import type { AttemptId } from "@usine/core/attempt";
import { InfraFailure } from "@usine/core/attempt/failure";
import { Effect, Exit, Fiber, Ref, Scope } from "effect";
import type { CheckoutRequest, ExecutorError, PreparedAttempt } from "./executor.ts";
import { withAttemptGuard } from "./guard.ts";

/** Tracks cancellation from preparation through release for one Executor instance. */
export const preparedAttemptsFor = (
  cancelLive: (attemptId: AttemptId) => Effect.Effect<boolean, ExecutorError>,
) =>
  Effect.sync(() => {
    const attempts = new Map<
      AttemptId,
      { readonly scope: Scope.Scope; readonly unavailable: Ref.Ref<boolean> }
    >();
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
        yield* Scope.close(active.scope, Exit.void);
      }
    }, Effect.uninterruptible);

    /** Owns partial preparation and the run host in one child scope, released at the Attempt's end. */
    const prepare = (
      acquire: Effect.Effect<PreparedAttempt, ExecutorError, Scope.Scope>,
      request: CheckoutRequest,
    ): Effect.Effect<PreparedAttempt, ExecutorError, Scope.Scope> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const scope = yield* Scope.fork(yield* Effect.scope);
          const unavailable = yield* Ref.make(false);
          attempts.set(request.attemptId, { scope, unavailable });
          yield* Scope.addFinalizer(
            scope,
            Effect.sync(() => {
              attempts.delete(request.attemptId);
            }),
          );
          yield* Scope.addFinalizer(scope, Ref.set(unavailable, true));
          // Resources have their own child scope: the supervising fiber's finalizer
          // must stop acquisition before any resources acquired by it are released.
          const resources = yield* Scope.fork(scope);
          const acquiring = yield* Effect.forkIn(Scope.provide(acquire, resources), scope);
          const prepared = yield* restore(Fiber.join(acquiring)).pipe(
            Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
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
              // Closing the owner's scope interrupts the session before checkout and
              // credential finalizers. Interrupting a caller waiting on join must also
              // stop that scoped fiber, so timeout/cancel completes the handshake first.
              return yield* Effect.acquireUseRelease(
                Effect.forkIn(withAttemptGuard(request, io, prepared.launch), scope),
                Fiber.join,
                Fiber.interrupt,
              ).pipe(Effect.onExit((exit) => Scope.close(scope, exit)));
            }),
          } satisfies PreparedAttempt;
        }),
      );

    return { prepare, cancel };
  });
