import { Clock, Effect, Exit, Schema } from "effect";

/**
 * A step of a configuration save or reload: waiting for the running one, reading the store,
 * parsing the candidate, checking restart-only changes, checking coordinator brains, preflighting
 * Workers, storing the revision, and applying it.
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

/** Logs that `step`, started at `started` milliseconds, finished with `outcome`. */
export const logStep = (
  step: RevisionStep,
  started: number,
  outcome: "passed" | "failed" | "interrupted",
) =>
  Effect.flatMap(Clock.currentTimeMillis, (now) =>
    Effect.logInfo("Configuration step finished", {
      step,
      durationMillis: now - started,
      outcome,
    }),
  );

/** Runs `effect` as `step` in its own span and logs its duration and outcome. */
export const timedStep = <A, E, R>(step: RevisionStep, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const exit = yield* Effect.exit(effect);
    yield* logStep(
      step,
      started,
      Exit.isSuccess(exit) ? "passed" : Exit.hasInterrupts(exit) ? "interrupted" : "failed",
    );
    return yield* exit;
  }).pipe(Effect.withSpan("CurrentInstance.step", { attributes: { step } }));
