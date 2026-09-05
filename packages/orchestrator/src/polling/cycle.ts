import type { ConfigFileError } from "@usine/config/file";
import { RepositoryName } from "@usine/core/repository";
import { type RunEngineError, SubmissionResult } from "@usine/engine/engine";
import type { ExpressionError } from "@usine/expression/model";
import type { GitHubAppError } from "@usine/github/github-app";
import { DateTime, Option, Schema } from "effect";
import { LabelPreflightFinding } from "../label-reconciler.ts";
import { configFileErrorLogFields } from "../trigger-submission.ts";

/** One repository whose cycle failed; its siblings finished normally. */
export class RepositoryPollFailure extends Schema.Class<RepositoryPollFailure>(
  "@usine/orchestrator/RepositoryPollFailure",
)({
  repository: RepositoryName,
  errorTag: Schema.NonEmptyString,
  message: Schema.String,
}) {}

/** Outcomes of one poll over all managed repositories, including isolated failures and backoff. */
export class PollCycle extends Schema.Class<PollCycle>("@usine/orchestrator/PollCycle")({
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
  /** Preflight failures such as a failed catalog request, kept through the interruption. */
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
