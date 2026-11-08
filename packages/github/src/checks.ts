import { ItemNumber } from "@usine/core/item";
import { CommitSha, RepositoryName, splitRepositoryName } from "@usine/core/repository";
import { type Brand, Clock, Context, DateTime, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { GitHubApp } from "./github-app.ts";
import type { GitHubAppError } from "./error.ts";
import { queryGraphql } from "./graphql.ts";
import { retryTransientRequest } from "./retry.ts";
import { API_ROOT, authorized, invalidResponse, statusError, transportError } from "./http.ts";
import { ActionsJob, FAILED_CONCLUSIONS, failedStepsExcerpt } from "./actions-log.ts";

/** The current PR head and CI state, including conflicts that prevent checks from starting. */
export class CheckSnapshot extends Schema.Class<
  CheckSnapshot,
  Brand.Brand<"@usine/github/checks/CheckSnapshot">
>("CheckSnapshot")({
  head: CommitSha,
  state: Schema.Literals(["pending", "success", "failure", "conflict"]),
}) {}

/** Failed check names and a bounded log excerpt for a fix attempt. */
export class CheckFailureEvidence extends Schema.Class<
  CheckFailureEvidence,
  Brand.Brand<"@usine/github/checks/CheckFailureEvidence">
>("CheckFailureEvidence")({
  jobs: Schema.Array(Schema.NonEmptyString),
  excerpt: Schema.String.check(Schema.isMaxLength(12000)),
}) {}

const Head = Schema.Struct({
  repository: Schema.NullOr(
    Schema.Struct({
      pullRequest: Schema.NullOr(
        Schema.Struct({
          headRefOid: CommitSha,
          headRef: Schema.NullOr(Schema.Struct({ target: Schema.Struct({ oid: CommitSha }) })),
          mergeable: Schema.Literals(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
          statusCheckRollup: Schema.NullOr(Schema.Struct({ state: Schema.String })),
        }),
      ),
    }),
  ),
});
const HEAD_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { headRefOid headRef { target { oid } } mergeable statusCheckRollup { state } }
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

const PendingChecks = Schema.Struct({
  total_count: Schema.Int,
  check_runs: Schema.Array(
    Schema.Struct({
      name: Schema.NonEmptyString,
      status: Schema.String,
      started_at: Schema.NullOr(Schema.DateTimeUtcFromString),
      details_url: Schema.NullOr(Schema.String),
    }),
  ),
});
const WorkflowRun = Schema.Struct({ workflow_id: Schema.Int.check(Schema.isGreaterThan(0)) });
const WorkflowRuns = Schema.Struct({
  workflow_runs: Schema.Array(Schema.Struct({ id: Schema.Int.check(Schema.isGreaterThan(0)) })),
});
const CompletedJobs = Schema.Struct({
  total_count: Schema.Int,
  jobs: Schema.Array(
    Schema.Struct({
      name: Schema.NonEmptyString,
      conclusion: Schema.NullOr(Schema.String),
      started_at: Schema.NullOr(Schema.DateTimeUtcFromString),
      completed_at: Schema.NullOr(Schema.DateTimeUtcFromString),
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
    readonly pendingDetails: (
      repository: RepositoryName,
      head: CommitSha,
    ) => Effect.Effect<string, GitHubAppError>;
  }
>()("@usine/github/checks/GitHubChecks") {
  static readonly layer = Layer.effect(
    GitHubChecks,
    Effect.gen(function* () {
      const app = yield* GitHubApp;
      const http = yield* HttpClient.HttpClient;
      const get = Effect.fn("GitHubChecks.get")(function* (path: string) {
        const token = yield* app.installationToken;
        const response = yield* http
          .execute(HttpClientRequest.get(`${API_ROOT}/${path}`).pipe(authorized(token.value)))
          .pipe(Effect.mapError((error) => transportError("read-ci-checks", error)));
        if (response.status !== 200) {
          const now = yield* Clock.currentTimeMillis;
          return yield* statusError("read-ci-checks", response, now);
        }
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
        const output = yield* Effect.gen(function* () {
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
            try: () => failedStepsExcerpt(steps, { format: "archive", bytes }),
            catch: () => invalidResponse("read-ci-checks", "Invalid Actions log archive"),
          });
          if (output.length === 0)
            return yield* invalidResponse("read-ci-checks", "No failed step logs are available");
          return output;
        }).pipe(
          Effect.catchIf(
            (error) => error._tag !== "GitHubRateLimitError",
            (error) =>
              Effect.gen(function* () {
                yield* Effect.logWarning("CI run archive unavailable; reading completed job log", {
                  job,
                  errorTag: error._tag,
                });
                const response = yield* get(`${prefix}/actions/jobs/${job}/logs`);
                const buffer = yield* response.arrayBuffer.pipe(
                  Effect.mapError((error) => invalidResponse("read-ci-checks", error.message)),
                );
                const output = failedStepsExcerpt(steps, {
                  format: "job",
                  bytes: new Uint8Array(buffer),
                });
                if (output.length === 0)
                  return yield* invalidResponse(
                    "read-ci-checks",
                    "No failed step logs are available",
                  );
                return output;
              }),
          ),
        );
        yield* Effect.logInfo("Read failed CI step logs", {
          job,
          steps: steps.steps
            .filter(({ conclusion }) => conclusion !== null && FAILED_CONCLUSIONS.has(conclusion))
            .map(({ name }) => name),
        });
        return output;
      });
      return {
        pendingDetails: Effect.fn("GitHubChecks.pendingDetails")(function* (
          repository: RepositoryName,
          head: CommitSha,
        ) {
          yield* Effect.annotateCurrentSpan({ repository, head });
          const { owner, name } = splitRepositoryName(repository);
          const prefix = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
          const pending: Array<(typeof PendingChecks.Type)["check_runs"][number]> = [];
          for (let page = 1; page <= 10; page++) {
            const response = yield* get(
              `${prefix}/commits/${head}/check-runs?per_page=100&filter=latest&page=${page}`,
            );
            const checks = yield* HttpClientResponse.schemaBodyJson(PendingChecks)(response).pipe(
              Effect.mapError((error) => invalidResponse("read-ci-checks", error.message)),
            );
            pending.push(...checks.check_runs.filter(({ status }) => status !== "completed"));
            if (page * 100 >= checks.total_count) break;
          }
          const histories = new Map<
            string,
            ReadonlyArray<(typeof CompletedJobs.Type)["jobs"][number]>
          >();
          const details: Array<string> = [];
          const now = yield* Clock.currentTimeMillis;
          for (const check of pending.slice(0, 10)) {
            const elapsed =
              check.started_at === null
                ? "unknown duration"
                : `${Math.max(0, Math.ceil((now - DateTime.toEpochMillis(check.started_at)) / 60000))} min`;
            const current = `${check.name} is ${check.status}${check.status === "in_progress" ? ` and has run for ${elapsed}` : ""}`;
            const run = check.details_url?.match(/\/actions\/runs\/(\d+)\/job\/\d+(?:\?|$)/u)?.[1];
            if (run === undefined || check.status !== "in_progress") {
              details.push(`${current}.`);
              continue;
            }
            const history = yield* Effect.gen(function* () {
              const cached = histories.get(run);
              if (cached !== undefined) return cached;
              const metadata = yield* get(`${prefix}/actions/runs/${run}`);
              const workflow = yield* HttpClientResponse.schemaBodyJson(WorkflowRun)(metadata).pipe(
                Effect.mapError((error) => invalidResponse("read-ci-checks", error.message)),
              );
              const response = yield* get(
                `${prefix}/actions/workflows/${workflow.workflow_id}/runs?status=success&per_page=1`,
              );
              const previous = yield* HttpClientResponse.schemaBodyJson(WorkflowRuns)(
                response,
              ).pipe(Effect.mapError((error) => invalidResponse("read-ci-checks", error.message)));
              const jobs: Array<(typeof CompletedJobs.Type)["jobs"][number]> = [];
              const previousRun = previous.workflow_runs[0];
              if (previousRun !== undefined) {
                for (let page = 1; page <= 10; page++) {
                  const response = yield* get(
                    `${prefix}/actions/runs/${previousRun.id}/jobs?per_page=100&filter=latest&page=${page}`,
                  );
                  const completed = yield* HttpClientResponse.schemaBodyJson(CompletedJobs)(
                    response,
                  ).pipe(
                    Effect.mapError((error) => invalidResponse("read-ci-checks", error.message)),
                  );
                  jobs.push(...completed.jobs);
                  if (page * 100 >= completed.total_count) break;
                }
              }
              return jobs;
            }).pipe(
              Effect.catch((error) =>
                Effect.logWarning("CI duration history unavailable", {
                  repository,
                  head,
                  job: check.name,
                  errorTag: error._tag,
                }).pipe(Effect.as([])),
              ),
            );
            histories.set(run, history);
            const previous = history.find(
              ({ name, conclusion }) => name === check.name && conclusion === "success",
            );
            const usual =
              previous !== undefined &&
              previous.started_at !== null &&
              previous.completed_at !== null
                ? `${Math.max(0, Math.ceil((DateTime.toEpochMillis(previous.completed_at) - DateTime.toEpochMillis(previous.started_at)) / 60000))} min in the last successful workflow run`
                : "unavailable";
            details.push(`${current}; previous successful duration: ${usual}.`);
          }
          return details.length === 0
            ? "No pending check jobs were reported for this head."
            : details.join(" ");
        }),
        snapshot: Effect.fn("GitHubChecks.snapshot")(function* (
          repository: RepositoryName,
          item: ItemNumber,
        ) {
          yield* Effect.annotateCurrentSpan({ repository, item });
          const { owner, name } = splitRepositoryName(repository);
          const installationToken = yield* app.installationToken;
          const result = yield* queryGraphql(
            http,
            installationToken,
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
          const branchHead = pr.headRef?.target.oid ?? pr.headRefOid;
          if (branchHead !== pr.headRefOid) {
            yield* Effect.logInfo("Pull request head lags its branch; CI remains pending", {
              repository,
              item,
              branchHead,
              pullRequestHead: pr.headRefOid,
            });
            return CheckSnapshot.make({ head: branchHead, state: "pending" });
          }
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
              Effect.catchIf(
                (error) => error._tag !== "GitHubRateLimitError",
                (error) =>
                  Effect.logWarning("CI job log unavailable; using the check output", {
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
