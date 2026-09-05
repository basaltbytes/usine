import { InfraFailure } from "@usine/core/attempt/failure";
import { Effect, Exit, Fiber, Ref, Scope } from "effect";
import type { CheckoutRequest, ExecutorError, PreparedAttempt } from "./executor.ts";

/** Owns partial preparation and the run host in one child scope, released at the Attempt's end. */
export const prepareAttempt = (
  acquire: Effect.Effect<PreparedAttempt, ExecutorError, Scope.Scope>,
  request: CheckoutRequest,
): Effect.Effect<PreparedAttempt, ExecutorError, Scope.Scope> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const scope = yield* Scope.fork(yield* Effect.scope);
      // acquireRelease masks acquisition by default in Effect rc.111. Only the
      // ownership transfer is masked here; clone, fetch, and lock waits must stop
      // promptly. Each acquiring implementation registers its own finalizers.
      const prepared = yield* restore(acquire).pipe(
        Scope.provide(scope),
        Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
      );
      const unavailable = yield* Ref.make(false);
      yield* Scope.addFinalizer(scope, Ref.set(unavailable, true));

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
            Effect.forkIn(
              prepared.launch(io).pipe(
                // End the timer with the live session. Checkout/grant finalizers run
                // afterward and cannot turn completed agent work into a retry.
                Effect.timeoutOrElse({
                  duration: `${request.maxAttemptMinutes} minutes`,
                  orElse: () =>
                    Effect.fail(
                      new InfraFailure({
                        message: `Attempt exceeded the ${request.maxAttemptMinutes}-minute budget`,
                        cause: new Error("attempt timeout"),
                      }),
                    ),
                }),
              ),
              scope,
            ),
            Fiber.join,
            Fiber.interrupt,
          ).pipe(Effect.onExit((exit) => Scope.close(scope, exit)));
        }),
      } satisfies PreparedAttempt;
    }),
  );
