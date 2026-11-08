import { canonicalLabelName } from "@usine/config/label";
import type { Attempt } from "@usine/core/attempt";
import { AgentFailure } from "@usine/core/attempt/failure";
import { GitHubItemKey, type ItemNumber } from "@usine/core/item";
import type { RepositoryName } from "@usine/core/repository";
import { CompletionCheck } from "@usine/engine/completion-check";
import type { Submission } from "@usine/engine/engine";
import { githubBotLogin } from "@usine/executor";
import { GitHubApp, isServerError } from "@usine/github/github-app";
import { GitHubItemHistory } from "@usine/github/item-history";
import { GitHubPolling } from "@usine/github/polling";
import { type Brand, DateTime, Duration, Effect, Layer, Result, Schedule, Schema } from "effect";
import { CurrentInstance } from "./current-instance/current-instance.ts";

/** The error when the Attempt's Worker is no longer configured, so its GitHub writer is unknown. */
class UnknownWriterError extends Schema.TaggedError<
  UnknownWriterError,
  Brand.Brand<"@usine/orchestrator/completion-check/UnknownWriterError">
>("@usine/orchestrator/UnknownWriterError")("UnknownWriterError", {
  message: Schema.NonEmptyString,
}) {}

/** The longest wait for one GitHub read. */
const READ_TIMEOUT = "15 seconds";

const logFields = (attempt: Attempt, submission: Submission) => ({
  runId: attempt.runId,
  attemptId: attempt.id,
  loop: submission.loop,
  repository: submission.repository,
  itemKey: submission.itemKey,
  outcomeLabels: submission.outcomeLabels,
});
type LogFields = ReturnType<typeof logFields>;

/**
 * Bounds `read` and retries it twice, after one and two seconds, when it times out or GitHub
 * answers with a server error. Other failures, such as 401, 403, and 404, end the read.
 */
const transientlyRetried =
  (fields: LogFields, read: "label events" | "current labels") =>
  <A, E extends { readonly _tag: string; readonly message: string }>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.timeout(READ_TIMEOUT),
      Effect.retry(($) =>
        $(Schedule.exponential("1 second")).pipe(
          Schedule.while(
            ({ input: error }) => error._tag === "TimeoutError" || isServerError(error),
          ),
          Schedule.upTo({ times: 2 }),
          Schedule.tap(({ input: error, attempt, duration }) =>
            Effect.logWarning("An outcome label read failed; retrying it", {
              ...fields,
              read,
              errorTag: error._tag,
              message: error.message,
              retry: attempt,
              delayMs: Duration.toMillis(duration),
            }),
          ),
        ),
      ),
    );

const matching = (submission: Submission, names: ReadonlyArray<string>) => {
  const wanted = new Set(submission.outcomeLabels.map(canonicalLabelName));
  return names.find((name) => wanted.has(canonicalLabelName(name)));
};

/**
 * Verifies the outcome labels of an Attempt on the Run's GitHub issue or pull request. Accepts an
 * outcome label that the Attempt's GitHub writer added at or after the Attempt started, even if a
 * later change removed it. If the Item's label events can't be read, accepts an outcome label
 * that is on the Item now.
 */
export const completionCheckLayer: Layer.Layer<
  CompletionCheck,
  never,
  CurrentInstance | GitHubApp | GitHubItemHistory | GitHubPolling
> = Layer.effect(
  CompletionCheck,
  Effect.gen(function* () {
    const app = yield* GitHubApp;
    const history = yield* GitHubItemHistory;
    const polling = yield* GitHubPolling;
    const instances = yield* CurrentInstance;

    const writerOf = Effect.fn("CompletionCheck.writer")(function* (attempt: Attempt) {
      const { config } = yield* instances.get;
      const worker = config.workers.find(({ name }) => name === attempt.worker);
      if (worker === undefined)
        return yield* UnknownWriterError.make({
          message: `Worker ${attempt.worker} is no longer configured, so its GitHub writer is unknown`,
        });
      const { login } = yield* app.botAccount;
      return githubBotLogin(worker.kind, login);
    });

    /** Returns the names of the labels that the Attempt's writer added since the Attempt started. */
    const addedLabels = Effect.fn("CompletionCheck.addedLabels")(function* (
      attempt: Attempt,
      repository: RepositoryName,
      item: ItemNumber,
      fields: LogFields,
    ) {
      // GitHub records label events to the second.
      const since = DateTime.startOf(attempt.startedAt, "second");
      const writer = yield* writerOf(attempt);
      const changes = yield* history
        .appChanges(repository, item, since, writer)
        .pipe(transientlyRetried(fields, "label events"));
      return changes.flatMap((change) =>
        change._tag === "LabelAdded" && DateTime.isGreaterThanOrEqualTo(change.at, since)
          ? [change.label.name]
          : [],
      );
    });

    const verify = Effect.fn("CompletionCheck.verify")(function* (
      attempt: Attempt,
      submission: Submission,
    ) {
      const fields = logFields(attempt, submission);
      yield* Effect.annotateCurrentSpan(fields);
      const [, , item] = yield* Schema.decodeEffect(GitHubItemKey)(submission.itemKey).pipe(
        Effect.tapError((error) =>
          Effect.logWarning(
            "The Run's item key doesn't name a GitHub issue or pull request, so its outcome labels can't be verified",
            { ...fields, cause: error.message },
          ),
        ),
        Effect.mapError(() =>
          AgentFailure.make({
            message: "Outcome labels require a Run on a GitHub issue or pull request.",
          }),
        ),
      );
      const expected = submission.outcomeLabels.join(", ");
      const added = yield* addedLabels(attempt, submission.repository, item, fields).pipe(
        Effect.result,
      );
      if (Result.isSuccess(added)) {
        const label = matching(submission, added.success);
        if (label === undefined) {
          const message = `The attempt added no outcome label; expected one of: ${expected}.`;
          yield* Effect.logWarning(message, { ...fields, addedLabels: added.success });
          return yield* AgentFailure.make({ message });
        }
        yield* Effect.logInfo("The attempt added an outcome label", { ...fields, label });
        return;
      }
      yield* Effect.logWarning(
        "Could not read the attempt's label events; verifying the current labels instead",
        { ...fields, errorTag: added.failure._tag, message: added.failure.message },
      );
      const current = yield* polling.itemLabels(submission.repository, item).pipe(
        transientlyRetried(fields, "current labels"),
        Effect.mapError((error) =>
          AgentFailure.make({
            message: `Could not verify the loop's outcome labels on GitHub: ${error.message}`,
          }),
        ),
        Effect.tapError((error) => Effect.logWarning(error.message, fields)),
      );
      const label = matching(
        submission,
        current.map(({ name }) => name),
      );
      if (label === undefined) {
        const message = `The loop ended without an outcome label; expected one of: ${expected}.`;
        yield* Effect.logWarning(message, fields);
        return yield* AgentFailure.make({ message });
      }
      yield* Effect.logInfo("The item has an outcome label", { ...fields, label });
    });

    return { verify };
  }),
);
