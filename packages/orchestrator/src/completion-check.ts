import { canonicalLabelName } from "@usine/config/label";
import { AgentFailure } from "@usine/core/attempt/failure";
import { ItemNumber } from "@usine/core/item";
import type { Submission } from "@usine/engine/engine";
import { CompletionCheck } from "@usine/engine/step-executor";
import { GitHubPolling, IssuePayload, PullRequestPayload } from "@usine/github/polling";
import { Duration, Effect, Layer, Schedule, Schema } from "effect";

const itemPayload = Schema.Union([PullRequestPayload, IssuePayload]);

/** Checks the saved loop's outcome labels against the current GitHub labels. */
export const completionCheckLayer = Layer.effect(
  CompletionCheck,
  Effect.gen(function* () {
    const github = yield* GitHubPolling;
    return Effect.fn("CompletionCheck.verify")(function* (submission: Submission) {
      const fields = {
        loop: submission.loop,
        repository: submission.repository,
        itemKey: submission.itemKey,
        outcomeLabels: submission.outcomeLabels,
      };
      yield* Effect.annotateCurrentSpan(fields);
      const payload = yield* Schema.decodeUnknownEffect(itemPayload)(submission.event.payload).pipe(
        Effect.mapError(() =>
          AgentFailure.make({ message: "Outcome labels require an issue or pull request event." }),
        ),
      );
      const current = yield* github
        .itemLabels(submission.repository, ItemNumber.make(payload.number))
        .pipe(
          Effect.timeout("15 seconds"),
          Effect.retry(($) =>
            $(Schedule.exponential("1 second")).pipe(
              Schedule.upTo({ times: 2 }),
              Schedule.tap(({ input: error, attempt, duration }) =>
                Effect.logWarning("Outcome label read failed; retrying verification", {
                  ...fields,
                  cause: error,
                  retry: attempt,
                  delayMs: Duration.toMillis(duration),
                }),
              ),
            ),
          ),
          Effect.mapError((error) =>
            AgentFailure.make({
              message: `Could not verify the loop's outcome labels on GitHub after three reads: ${error.message}`,
            }),
          ),
          Effect.tapError((error) => Effect.logWarning(error.message, fields)),
        );
      const labels = new Set(current.map(({ name }) => canonicalLabelName(name)));
      if (!submission.outcomeLabels.some((label) => labels.has(canonicalLabelName(label)))) {
        const message = `The loop ended without an outcome label; expected one of: ${submission.outcomeLabels.join(", ")}.`;
        yield* Effect.logWarning(message, fields);
        return yield* AgentFailure.make({ message });
      }
      yield* Effect.logInfo("Loop outcome label verified", fields);
    });
  }),
);
