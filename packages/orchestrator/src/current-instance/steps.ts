import { Clock, Effect, Exit, Schema, type Semaphore } from "effect";

/**
 * A step of a configuration save or reload: waiting for the running one, reading the store,
 * parsing the candidate, checking restart-only changes, checking coordinator brains, preflighting
 * Workers, storing the revision, and applying it. The startup check of coordinator brains is also
 * the `coordinator-brains` step.
 */
export const RevisionStep = Schema.Literals([
  "wait",
  "read",
  "parse",
  "restart",
  "coordinator-brains",
  "worker-preflight",
  "store",
  "apply",
]);
/** A step of a configuration save or reload. */
export type RevisionStep = typeof RevisionStep.Type;

const outcome = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isSuccess(exit) ? "passed" : Exit.hasInterrupts(exit) ? "interrupted" : "failed";

/** Logs that `step`, started at `started` milliseconds, finished with the outcome of `exit`. */
const logStep = (step: RevisionStep, started: number, exit: Exit.Exit<unknown, unknown>) =>
  Effect.flatMap(Clock.currentTimeMillis, (now) =>
    Effect.logInfo("Configuration step finished", {
      step,
      durationMillis: now - started,
      outcome: outcome(exit),
    }),
  );

/**
 * Runs `effect` as `step` in its own span and logs its duration and outcome, including when it is
 * interrupted.
 */
export const timedStep = <A, E, R>(step: RevisionStep, effect: Effect.Effect<A, E, R>) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      const exit = yield* Effect.exit(restore(effect));
      yield* logStep(step, started, exit);
      return yield* exit;
    }),
  ).pipe(Effect.withSpan("CurrentInstance.step", { attributes: { step } }));

/**
 * Runs `effect` with a permit from `semaphore`. The time until the permit is granted is the `wait`
 * step, with its own span and log line; a caller interrupted while it waits logs the `wait` step
 * with outcome `interrupted`.
 */
export const afterRunning =
  (semaphore: Semaphore.Semaphore) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const span = yield* Effect.makeSpan("CurrentInstance.step", {
          attributes: { step: "wait" },
        });
        const queued = yield* Clock.currentTimeMillis;
        let waiting = true;
        const finish = (exit: Exit.Exit<unknown, unknown>) =>
          Effect.flatMap(Clock.currentTimeNanos, (now) =>
            Effect.sync(() => span.end(now, exit)),
          ).pipe(Effect.andThen(logStep("wait", queued, exit)));
        const granted = Effect.uninterruptible(
          Effect.suspend(() => {
            waiting = false;
            return finish(Exit.void);
          }),
        );
        return yield* restore(semaphore.withPermits(1)(Effect.andThen(granted, effect))).pipe(
          Effect.onExit((exit) => (waiting ? finish(exit) : Effect.void)),
        );
      }),
    );
