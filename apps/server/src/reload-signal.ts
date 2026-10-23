import type { CurrentInstance } from "@usine/orchestrator/current-instance";
import { Effect, Queue } from "effect";

/**
 * Reloads the instance folder on each SIGHUP until the scope closes, instead of exiting. A SIGHUP
 * during a reload triggers one more reload.
 */
export const reloadOnHangup = (instances: CurrentInstance["Service"]) =>
  Effect.gen(function* () {
    const signals = yield* Queue.sliding<void>(1);
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const onSignal = () => {
          Queue.offerUnsafe(signals, undefined);
        };
        process.on("SIGHUP", onSignal);
        return onSignal;
      }),
      (onSignal) =>
        Effect.sync(() => {
          process.removeListener("SIGHUP", onSignal);
        }),
    );
    yield* Effect.forkScoped(
      Queue.take(signals).pipe(
        Effect.andThen(Effect.logInfo("SIGHUP received; reloading the instance folder")),
        Effect.andThen(instances.reload),
        // The reload logs its own outcome.
        Effect.ignore,
        Effect.forever,
      ),
    );
  });
