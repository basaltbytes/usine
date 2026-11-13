import { canonicalLabelName } from "@usine/core/label";
import { type Attempt, AttemptWindow, windowHolds, windowOf } from "@usine/core/attempt";
import { AgentFailure } from "@usine/core/attempt/failure";
import { GitHubItemKey, type ItemNumber } from "@usine/core/item";
import type { RepositoryName } from "@usine/core/repository";
import type { BotLogin } from "@usine/core/worker";
import type { Worker as ConfigWorker } from "@usine/config/factory";
import { CompletionCheck } from "@usine/engine/completion-check";
import type { Submission } from "@usine/engine/engine";
import { githubBotLogin } from "@usine/executor";
import { GitHubApp, type GitHubAppError, isRefusal } from "@usine/github/github-app";
import { GitHubItemHistory, type GitHubItemNotFoundError } from "@usine/github/item-history";
import { GitHubPolling } from "@usine/github/polling";
import {
  type Brand,
  type Cause,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Result,
  Schedule,
  Schema,
} from "effect";
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
 * Bounds `read` and retries it twice, after one and two seconds, after a timeout, a transport
 * failure, a server error, or a rate limit. A refusal, a missing Item, and an invalid response,
 * such as a timeline longer than ten pages, end the read: GitHub returns them again, and the
 * GraphQL client already retries GitHub's transient server errors.
 */
const transientlyRetried =
  (fields: LogFields, read: "label events" | "current labels") =>
  <A, E extends GitHubAppError | GitHubItemNotFoundError | UnknownWriterError>(
    effect: Effect.Effect<A, E>,
  ) =>
    effect.pipe(
      Effect.timeout(READ_TIMEOUT),
      Effect.retry(($) =>
        $(Schedule.exponential("1 second")).pipe(
          Schedule.while(({ input: error }) => isTransient(error)),
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

const isTransient = (
  error: GitHubAppError | GitHubItemNotFoundError | UnknownWriterError | Cause.TimeoutError,
): boolean => {
  switch (error._tag) {
    case "TimeoutError":
      return true;
    case "GitHubItemNotFoundError":
    case "InvalidGitHubResponseError":
    case "UnknownWriterError":
      return false;
    default:
      return !isRefusal(error);
  }
};

const matching = (submission: Submission, names: ReadonlyArray<string>) => {
  const wanted = new Set(submission.outcomeLabels.map(canonicalLabelName));
  return names.find((name) => wanted.has(canonicalLabelName(name)));
};

/**
 * Verifies the outcome labels of an Attempt on the Run's GitHub issue or pull request. Accepts an
 * outcome label that the Attempt's GitHub writer added during the Attempt, or that an earlier
 * Attempt of the Run added during that Attempt, even if a later change removed it. If the Item's
 * label events can't be read, accepts an outcome label that is on the Item now.
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

    /**
     * Returns the writer of `attempt`: the bot of the Worker kind it started on, or, for an
     * Attempt recorded without one, of its Worker's configured kind.
     */
    const writerOf = (attempt: Attempt, workers: ReadonlyArray<ConfigWorker>, app: BotLogin) =>
      Option.match(attempt.workerKind, {
        onSome: (kind) => Effect.succeed(githubBotLogin(kind, app)),
        onNone: () => {
          const worker = workers.find(({ name }) => name === attempt.worker);
          return worker === undefined
            ? Effect.fail(
                UnknownWriterError.make({
                  message: `Worker ${attempt.worker} is no longer configured, so its GitHub writer is unknown`,
                }),
              )
            : Effect.succeed(githubBotLogin(worker.kind, app));
        },
      });

    /**
     * Returns the labels that the Run's Attempts added: each label added by an Attempt's writer
     * during that Attempt. An earlier Attempt without a recorded end adds none.
     */
    const addedLabels = Effect.fn("CompletionCheck.addedLabels")(function* (
      attempt: Attempt,
      repository: RepositoryName,
      item: ItemNumber,
      fields: LogFields,
      runAttempts: ReadonlyArray<Attempt>,
    ) {
      const { config } = yield* instances.get;
      const earlier = runAttempts.filter((previous) => previous.number < attempt.number);
      const unbounded = earlier.filter((previous) => Option.isNone(windowOf(previous)));
      if (unbounded.length > 0)
        yield* Effect.logInfo(
          "Earlier Attempts have no recorded end, so their label events don't count",
          { ...fields, attempts: unbounded.map(({ id }) => id) },
        );
      const own = AttemptWindow.make({
        attemptId: attempt.id,
        startedAt: attempt.startedAt,
        endedAt: Option.none(),
      });
      const attempts = [
        ...earlier.flatMap((previous) =>
          Option.toArray(Option.map(windowOf(previous), (window) => ({ previous, window }))),
        ),
        { previous: attempt, window: own },
      ];
      return yield* Effect.gen(function* () {
        const { login } = yield* app.botAccount;
        const windows = new Map<BotLogin, Array<AttemptWindow>>();
        for (const { previous, window } of attempts) {
          const writer = yield* writerOf(previous, config.workers, login);
          windows.set(writer, [...(windows.get(writer) ?? []), window]);
        }
        // At most two writers exist, the App's bot and the exe.dev integration's bot, so the
        // reads run together and share one timeout.
        const timelines = yield* Effect.forEach(
          windows,
          ([writer, held]) => {
            const first = held.reduce((earliest, window) =>
              DateTime.isLessThan(window.startedAt, earliest.startedAt) ? window : earliest,
            );
            // GitHub records label events to the second.
            const since = DateTime.startOf(first.startedAt, "second");
            return history
              .appChanges(repository, item, since, writer)
              .pipe(
                Effect.map((changes) =>
                  changes.flatMap((change) =>
                    change._tag === "LabelAdded" &&
                    held.some((window) => windowHolds(window, change.at))
                      ? [change.label.name]
                      : [],
                  ),
                ),
              );
          },
          { concurrency: 2 },
        );
        return timelines.flat();
      }).pipe(transientlyRetried(fields, "label events"));
    });

    const verify = Effect.fn("CompletionCheck.verify")(function* (
      attempt: Attempt,
      submission: Submission,
      runAttempts: ReadonlyArray<Attempt>,
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
      const added = yield* addedLabels(
        attempt,
        submission.repository,
        item,
        fields,
        runAttempts,
      ).pipe(Effect.result);
      if (Result.isSuccess(added)) {
        const label = matching(submission, added.success);
        if (label === undefined) {
          const message = `The run added no outcome label; expected one of: ${expected}.`;
          yield* Effect.logWarning(message, { ...fields, addedLabels: added.success });
          return yield* AgentFailure.make({ message });
        }
        yield* Effect.logInfo("The run added an outcome label", { ...fields, label });
        return;
      }
      yield* Effect.logWarning(
        "Could not read the run's label events; verifying the current labels instead",
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
