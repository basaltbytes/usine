import type { ConfigFileError } from "@usine/config/file";
import { RepositoryName } from "@usine/core/repository";
import { type RunEngineError, SubmissionResult } from "@usine/engine/engine";
import type { ExpressionError } from "@usine/expression/expression-engine";
import type { GitHubAppError } from "@usine/github/github-app";
import type { GitHubItemNotFoundError } from "@usine/github/polling";
import { DateTime, Effect, Option, Schema } from "effect";
import { LabelPreflightFinding } from "../label-reconciler.ts";
import { configFileErrorLogFields } from "../trigger-submission.ts";

/**
 * A failure isolated to one repository, or to one Loop and Item of it; the
 * repository's siblings finished normally. A Loop that cannot evaluate an Item
 * is reported in every cycle until the Item or the Loop changes.
 */
export class RepositoryPollFailure extends Schema.Class<RepositoryPollFailure>(
  "@usine/orchestrator/RepositoryPollFailure",
)({
  repository: RepositoryName,
  errorTag: Schema.NonEmptyString,
  message: Schema.String,
}) {}

/** When one managed repository last completed a poll in this process. */
export class RepositoryPoll extends Schema.Class<RepositoryPoll>(
  "@usine/orchestrator/RepositoryPoll",
)({
  repository: RepositoryName,
  completedAt: Schema.DateTimeUtc,
}) {}

/** Outcomes of one poll over all managed repositories, including isolated failures and backoff. */
export class PollCycle extends Schema.Class<PollCycle>("@usine/orchestrator/PollCycle")({
  /**
   * When each managed repository last completed a poll, this cycle or an
   * earlier one of the same process; a repository yet to complete one is absent.
   */
  repositoryPolls: Schema.Array(RepositoryPoll).pipe(
    Schema.withConstructorDefault(Effect.succeed([])),
  ),
  repositories: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  changedItems: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  submissions: Schema.Array(SubmissionResult),
  /** How many Runs this cycle revoked because their item stopped matching. */
  revokedRuns: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  failures: Schema.Array(RepositoryPollFailure),
  preflightFindings: Schema.Array(LabelPreflightFinding),
  nextPollAt: Schema.Option(Schema.DateTimeUtc),
}) {}

/** Recoverable failures that leave a repository eligible for another poll. */
export type RepositoryPollError =
  | ConfigFileError
  | ExpressionError
  | GitHubAppError
  | GitHubItemNotFoundError
  | RunEngineError;

/** Safe diagnostic fields for a failed repository operation. */
export const repositoryFailureLogFields = (error: RepositoryPollError) => {
  const common = { errorTag: error._tag, message: error.message };
  if (error._tag === "ConfigFileError") {
    return { ...common, ...configFileErrorLogFields(error) };
  }
  if (error._tag === "ExpressionCheckError" || error._tag === "ExpressionEvaluationError") {
    return { ...common, expression: error.source };
  }
  return common;
};

/** A cycle whose preflight finished but whose repository poll failed. */
export interface InterruptedRepositoryCycle {
  readonly _tag: "InterruptedRepositoryCycle";
  readonly error: RepositoryPollError;
  /** Preflight failures such as a failed catalog request, and the Loop failures the cursor recorded, kept through the interruption. */
  readonly failures: ReadonlyArray<RepositoryPollFailure>;
  readonly preflightFindings: ReadonlyArray<LabelPreflightFinding>;
  readonly nextPollAt: Option.Option<DateTime.Utc>;
}

/** The latest requested backoff; no recommendation leaves the configured interval in charge. */
export const latestPollAt = (
  values: ReadonlyArray<Option.Option<DateTime.Utc>>,
): Option.Option<DateTime.Utc> => {
  const epochs = values.flatMap((value) =>
    Option.match(value, {
      onNone: () => [],
      onSome: (dateTime) => [DateTime.toEpochMillis(dateTime)],
    }),
  );
  return epochs.length === 0 ? Option.none() : DateTime.make(Math.max(...epochs));
};
