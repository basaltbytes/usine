import { ItemNumber } from "@usine/core/item";
import { CommitSha, RepositoryName, splitRepositoryName } from "@usine/core/repository";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { GitHubApp } from "./github-app.ts";
import type { GitHubAppError } from "./error.ts";
import { queryGraphql } from "./graphql.ts";
import { retryTransientRequest } from "./retry.ts";
import { API_ROOT, authorized, invalidResponse, statusError, transportError } from "./http.ts";
import { ActionsJob, FAILED_CONCLUSIONS, failedStepsExcerpt } from "./actions-log.ts";

/** The current PR head and CI state, including conflicts that prevent checks from starting. */
export class CheckSnapshot extends Schema.Class<CheckSnapshot>("CheckSnapshot")({
  head: CommitSha,
  state: Schema.Literals(["pending", "success", "failure", "conflict"]),
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
          mergeable: Schema.Literals(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
          statusCheckRollup: Schema.NullOr(Schema.Struct({ state: Schema.String })),
        }),
      ),
    }),
  ),
});
const HEAD_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { headRefOid mergeable statusCheckRollup { state } }
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
      }, retryTransientRequest);
      const jobFailure = Effect.fn("GitHubChecks.jobFailure")(function* (
        prefix: string,
        job: string,
        archives: Map<string, Uint8Array>,
      ) {
        yield* Effect.annotateCurrentSpan({ job });
        const metadata = yield* get(`${prefix}/actions/jobs/${job}`);
        const steps = yield* HttpClientResponse.schemaBodyJson(ActionsJob)(metadata).pipe(
          Effect.mapError((error) => invalidResponse("read-ci-checks", error.message)),
        );
        yield* Effect.annotateCurrentSpan({
          actionsRunId: steps.run_id,
          actionsRunAttempt: steps.run_attempt,
        });
        const path = `${prefix}/actions/runs/${steps.run_id}/attempts/${steps.run_attempt}/logs`;
        let archive = archives.get(path);
        if (archive === undefined) {
          const response = yield* get(path);
          const buffer = yield* response.arrayBuffer.pipe(
            Effect.mapError((error) => invalidResponse("read-ci-checks", error.message)),
          );
          archive = new Uint8Array(buffer);
          archives.set(path, archive);
        }
        const bytes = archive;
        const output = yield* Effect.try({
          try: () => failedStepsExcerpt(steps, bytes),
          catch: () => invalidResponse("read-ci-checks", "Invalid Actions log archive"),
        });
        if (output.length === 0)
          return yield* invalidResponse("read-ci-checks", "No failed step logs are available");
        yield* Effect.logInfo("Read failed CI step logs", {
          job,
          steps: steps.steps
            .filter(({ conclusion }) => conclusion !== null && FAILED_CONCLUSIONS.has(conclusion))
            .map(({ name }) => name),
        });
        return output;
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
          return CheckSnapshot.make({
            head: pr.headRefOid,
            state:
              state === "SUCCESS"
                ? "success"
                : state === "FAILURE" || state === "ERROR"
                  ? "failure"
                  : state === undefined && pr.mergeable === "CONFLICTING"
                    ? "conflict"
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
          const archives = new Map<string, Uint8Array>();
          for (const check of failed.slice(0, 4)) {
            const job = check.details_url?.match(/\/actions\/runs\/\d+\/job\/(\d+)(?:\?|$)/u)?.[1];
            const log =
              job === undefined
                ? Effect.succeed(check.output.text ?? check.output.summary ?? "")
                : jobFailure(prefix, job, archives);
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
            return CheckFailureEvidence.make({
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
          return CheckFailureEvidence.make({
            jobs: failed.map(({ name }) => name),
            excerpt: excerpts.join("\n\n").slice(-12000),
          });
        }),
      };
    }),
  );
}
