import type { Attempt } from "@usine/core/attempt";
import type { AgentFailure } from "@usine/core/attempt/failure";
import { Context, Effect, Layer } from "effect";
import type { Submission } from "./engine/submission.ts";

/**
 * The service that verifies a successful Attempt's outcome labels before the engine records the
 * success. Its `AgentFailure` fails the Attempt and the Run without starting another Attempt.
 */
export class CompletionCheck extends Context.Service<
  CompletionCheck,
  {
    /**
     * Verifies an outcome label added by any of `runAttempts` since the Run's first Attempt.
     * The engine calls it only when the list is nonempty and the Run would record the success.
     */
    readonly verify: (
      attempt: Attempt,
      submission: Submission,
      runAttempts: ReadonlyArray<Attempt>,
    ) => Effect.Effect<void, AgentFailure>;
  }
>()("@usine/engine/completion-check/CompletionCheck") {
  /**
   * Accepts every completion without reading the Item, for hosts that don't verify outcome labels.
   * Logs a warning for each completion it accepts.
   */
  static readonly unverified: Layer.Layer<CompletionCheck> = Layer.succeed(CompletionCheck)({
    verify: Effect.fn("CompletionCheck.unverified")(function* (
      attempt: Attempt,
      submission: Submission,
    ) {
      yield* Effect.logWarning(
        "This host doesn't verify outcome labels; accepting the completion",
        {
          runId: attempt.runId,
          attemptId: attempt.id,
          loop: submission.loop,
          outcomeLabels: submission.outcomeLabels,
        },
      );
    }),
  });
}
