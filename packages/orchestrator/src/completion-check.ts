import { canonicalLabelName } from "@usine/config/label";
import { AgentFailure, InfraFailure } from "@usine/core/attempt/failure";
import type { Submission } from "@usine/engine/engine";
import { CompletionCheck } from "@usine/engine/step-executor";
import {
  ChangedIssue,
  ChangedPullRequest,
  GitHubPolling,
  IssuePayload,
  PullRequestPayload,
} from "@usine/github/polling";
import { DateTime, Effect, Layer, Schema } from "effect";

const itemPayload = Schema.Union([PullRequestPayload, IssuePayload]);

/** Checks the saved loop's outcome labels against a fresh GitHub item snapshot. */
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
      const now = yield* DateTime.now;
      const changed =
        "headRefOid" in payload
          ? ChangedPullRequest.make({ number: payload.number, updatedAt: now })
          : ChangedIssue.make({ number: payload.number, updatedAt: now });
      const snapshot = yield* github.snapshot(submission.repository, changed).pipe(
        Effect.timeout("5 seconds"),
        Effect.mapError((error) =>
          InfraFailure.make({
            message: "Could not verify the loop's outcome labels on GitHub.",
            cause: error,
          }),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(error.message, { ...fields, cause: error.cause }),
        ),
      );
      const labels = new Set(
        snapshot.payload.labels.nodes.map(({ name }) => canonicalLabelName(name)),
      );
      if (!submission.outcomeLabels.some((label) => labels.has(canonicalLabelName(label)))) {
        const message = `The loop ended without an outcome label; expected one of: ${submission.outcomeLabels.join(", ")}.`;
        yield* Effect.logWarning(message, fields);
        return yield* AgentFailure.make({ message });
      }
      yield* Effect.logInfo("Loop outcome label verified", fields);
    });
  }),
);
