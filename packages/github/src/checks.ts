import { ItemNumber } from "@usine/core/item";
import { CommitSha, RepositoryName, splitRepositoryName } from "@usine/core/repository";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { GitHubApp } from "./github-app.ts";
import type { GitHubAppError } from "./error.ts";
import { queryGraphql } from "./graphql.ts";
import { API_ROOT, authorized, invalidResponse, statusError, transportError } from "./http.ts";

/** The current PR head and GitHub's aggregate check state; missing checks remain pending. */
export class CheckSnapshot extends Schema.Class<CheckSnapshot>("CheckSnapshot")({
  head: CommitSha,
  state: Schema.Literals(["pending", "success", "failure"]),
}) {}

/** Failed check names and a bounded log excerpt for a fix attempt. */
export class CheckFailureEvidence extends Schema.Class<CheckFailureEvidence>(
  "CheckFailureEvidence",
)({
  jobs: Schema.Array(Schema.NonEmptyString),
  excerpt: Schema.String.check(Schema.isMaxLength(12000)),
}) {}

const Head = Schema.Struct({
  repository: Schema.NullOr(
    Schema.Struct({
      pullRequest: Schema.NullOr(
        Schema.Struct({
          headRefOid: CommitSha,
          statusCheckRollup: Schema.NullOr(Schema.Struct({ state: Schema.String })),
        }),
      ),
    }),
  ),
});
const HEAD_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { headRefOid statusCheckRollup { state } }
  }
}`;
const Checks = Schema.Struct({
  total_count: Schema.Int,
  check_runs: Schema.Array(
    Schema.Struct({
      name: Schema.NonEmptyString,
      conclusion: Schema.NullOr(Schema.String),
      details_url: Schema.NullOr(Schema.String),
      output: Schema.Struct({
        summary: Schema.NullOr(Schema.String),
        text: Schema.NullOr(Schema.String),
      }),
    }),
  ),
});
const Statuses = Schema.Struct({
  statuses: Schema.Array(
    Schema.Struct({
      context: Schema.NonEmptyString,
      state: Schema.String,
      description: Schema.NullOr(Schema.String),
    }),
  ),
});
const FAILED_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
  "stale",
]);

/** Reads aggregate CI and failure diagnostics without starting an agent. */
export class GitHubChecks extends Context.Service<
  GitHubChecks,
  {
    readonly snapshot: (
      repository: RepositoryName,
      item: ItemNumber,
    ) => Effect.Effect<CheckSnapshot, GitHubAppError>;
    readonly failures: (
      repository: RepositoryName,
      head: CommitSha,
    ) => Effect.Effect<CheckFailureEvidence, GitHubAppError>;
  }
>()("@usine/github/GitHubChecks") {
  static readonly layer = Layer.effect(
    GitHubChecks,
    Effect.gen(function* () {
      const app = yield* GitHubApp;
      const http = yield* HttpClient.HttpClient;
      const get = Effect.fn("GitHubChecks.get")(function* (path: string) {
        const token = yield* app.installationToken();
        const response = yield* http
          .execute(HttpClientRequest.get(`${API_ROOT}/${path}`).pipe(authorized(token.value)))
          .pipe(Effect.mapError((error) => transportError("read-ci-checks", error)));
        if (response.status !== 200)
          return yield* statusError("read-ci-checks", response, yield* Clock.currentTimeMillis);
        return response;
      });
      return {
        snapshot: Effect.fn("GitHubChecks.snapshot")(function* (
          repository: RepositoryName,
          item: ItemNumber,
        ) {
          yield* Effect.annotateCurrentSpan({ repository, item });
          const { owner, name } = splitRepositoryName(repository);
          const result = yield* queryGraphql(
            http,
            yield* app.installationToken(),
            "read-ci-checks",
            HEAD_QUERY,
            { owner, name, number: item },
            Head,
          );
          const pr = result.repository?.pullRequest;
          if (pr === undefined || pr === null)
            return yield* invalidResponse(
              "read-ci-checks",
              "The pull request awaiting CI is unavailable",
            );
          const state = pr.statusCheckRollup?.state;
          return new CheckSnapshot({
            head: pr.headRefOid,
            state:
              state === "SUCCESS"
                ? "success"
                : state === "FAILURE" || state === "ERROR"
                  ? "failure"
                  : "pending",
          });
        }),
        failures: Effect.fn("GitHubChecks.failures")(function* (
          repository: RepositoryName,
          head: CommitSha,
        ) {
          yield* Effect.annotateCurrentSpan({ repository, head });
          const { owner, name } = splitRepositoryName(repository);
          const prefix = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
          const failed: Array<(typeof Checks.Type)["check_runs"][number]> = [];
          for (let page = 1; page <= 10; page++) {
            const response = yield* get(
              `${prefix}/commits/${head}/check-runs?per_page=100&filter=latest&page=${page}`,
            );
            const checks = yield* HttpClientResponse.schemaBodyJson(Checks)(response).pipe(
              Effect.mapError((error) => invalidResponse("read-ci-checks", error.message)),
            );
            failed.push(
              ...checks.check_runs.filter(
                ({ conclusion }) => conclusion !== null && FAILED_CONCLUSIONS.has(conclusion),
              ),
            );
            if (page * 100 >= checks.total_count) break;
          }
          const excerpts: Array<string> = [];
          for (const check of failed.slice(0, 4)) {
            const job = check.details_url?.match(/\/actions\/runs\/\d+\/job\/(\d+)(?:\?|$)/u)?.[1];
            const log =
              job === undefined
                ? Effect.succeed(check.output.text ?? check.output.summary ?? "")
                : get(`${prefix}/actions/jobs/${job}/logs`).pipe(
                    Effect.flatMap((response) =>
                      response.text.pipe(
                        Effect.mapError((error) =>
                          invalidResponse("read-ci-checks", error.message),
                        ),
                      ),
                    ),
                  );
            const output = yield* log.pipe(
              Effect.catch((error) =>
                error._tag === "GitHubRateLimitError"
                  ? Effect.fail(error)
                  : Effect.logWarning("CI job log unavailable; using the check output", {
                      repository,
                      head,
                      job: check.name,
                      errorTag: error._tag,
                    }).pipe(Effect.as(check.output.text ?? check.output.summary ?? error.message)),
              ),
            );
            excerpts.push(`${check.name}\n${output.slice(-2800)}`);
          }
          if (failed.length === 0) {
            const response = yield* get(`${prefix}/commits/${head}/status?per_page=100`);
            const statuses = yield* HttpClientResponse.schemaBodyJson(Statuses)(response).pipe(
              Effect.mapError((error) => invalidResponse("read-ci-checks", error.message)),
            );
            const failures = statuses.statuses.filter(
              ({ state }) => state === "failure" || state === "error",
            );
            return new CheckFailureEvidence({
              jobs: failures.map(({ context }) => context),
              excerpt: failures
                .slice(0, 4)
                .map(({ context, description }) => `${context}\n${description ?? ""}`.slice(-2900))
                .join("\n\n")
                .slice(-12000),
            });
          }
          yield* Effect.logInfo("Read failed CI checks", {
            repository,
            head,
            jobs: failed.map(({ name }) => name),
          });
          return new CheckFailureEvidence({
            jobs: failed.map(({ name }) => name),
            excerpt: excerpts.join("\n\n").slice(-12000),
          });
        }),
      };
    }),
  );
}
