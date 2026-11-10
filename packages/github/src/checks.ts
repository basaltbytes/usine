import { ItemNumber } from "@usine/core/item";
import { CommitSha, RepositoryName, splitRepositoryName } from "@usine/core/repository";
import { type Brand, Clock, Context, DateTime, Effect, Layer, Option, Schema } from "effect";
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

export class PendingCheck extends Schema.Class<
  PendingCheck,
  Brand.Brand<"@usine/github/checks/PendingCheck">
>("PendingCheck")({
  name: Schema.NonEmptyString,
  status: Schema.NonEmptyString,
  startedAt: Schema.Option(Schema.DateTimeUtc),
  elapsedMilliseconds: Schema.Option(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  previousDurationMilliseconds: Schema.Option(
    Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
}) {}

/** The latest run of a workflow on a head that failed or was canceled although none of its jobs failed. */
export class IncompleteWorkflowRun extends Schema.Class<
  IncompleteWorkflowRun,
  Brand.Brand<"@usine/github/checks/IncompleteWorkflowRun">
>("IncompleteWorkflowRun")({
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  workflow: Schema.NonEmptyString,
  conclusion: Schema.Literals(["failure", "cancelled"]),
  url: Schema.NonEmptyString,
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
      status: Schema.NonEmptyString,
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

const HeadWorkflowRuns = Schema.Struct({
  total_count: Schema.Int,
  workflow_runs: Schema.Array(
    Schema.Struct({
      id: Schema.Int.check(Schema.isGreaterThan(0)),
      name: Schema.NullOr(Schema.String),
      workflow_id: Schema.Int,
      event: Schema.String,
      run_number: Schema.Int,
      status: Schema.NullOr(Schema.String),
      conclusion: Schema.NullOr(Schema.String),
      html_url: Schema.NonEmptyString,
    }),
  ),
});
const RunJobs = Schema.Struct({
  total_count: Schema.Int,
  jobs: Schema.Array(Schema.Struct({ conclusion: Schema.NullOr(Schema.String) })),
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
    ) => Effect.Effect<ReadonlyArray<PendingCheck>, GitHubAppError>;
    /**
     * Returns the latest workflow runs on `head` that concluded `failure` or `cancelled` although
     * none of their jobs failed, such as a run whose jobs GitHub Actions never created.
     */
    readonly incompleteRuns: (
      repository: RepositoryName,
      head: CommitSha,
    ) => Effect.Effect<ReadonlyArray<IncompleteWorkflowRun>, GitHubAppError>;
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
      const checkRuns = Effect.fn("GitHubChecks.checkRuns")(function* <C>(
        prefix: string,
        head: CommitSha,
        schema: Schema.Codec<
          { readonly total_count: number; readonly check_runs: ReadonlyArray<C> },
          unknown,
          never,
          unknown
        >,
      ) {
        yield* Effect.annotateCurrentSpan({ prefix, head });
        const runs: Array<C> = [];
        for (let page = 1; page <= 10; page++) {
          const response = yield* get(
            `${prefix}/commits/${head}/check-runs?per_page=100&filter=latest&page=${page}`,
          );
          const checks = yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
            Effect.mapError((error) => invalidResponse("read-ci-checks", error.message)),
          );
          runs.push(...checks.check_runs);
          if (page * 100 >= checks.total_count) break;
        }
        return runs;
      });
      const previousSuccessfulJobs = Effect.fn("GitHubChecks.previousSuccessfulJobs")(function* (
        prefix: string,
        run: string,
        histories: Map<string, ReadonlyArray<(typeof CompletedJobs.Type)["jobs"][number]>>,
      ) {
        yield* Effect.annotateCurrentSpan({ prefix, run });
        const cached = histories.get(run);
        if (cached !== undefined) return cached;
        const metadata = yield* get(`${prefix}/actions/runs/${run}`);
        const workflow = yield* HttpClientResponse.schemaBodyJson(WorkflowRun)(metadata).pipe(
          Effect.mapError((error) => invalidResponse("read-ci-checks", error.message)),
        );
        const response = yield* get(
          `${prefix}/actions/workflows/${workflow.workflow_id}/runs?status=success&per_page=1`,
        );
        const previous = yield* HttpClientResponse.schemaBodyJson(WorkflowRuns)(response).pipe(
          Effect.mapError((error) => invalidResponse("read-ci-checks", error.message)),
        );
        const jobs: Array<(typeof CompletedJobs.Type)["jobs"][number]> = [];
        const previousRun = previous.workflow_runs[0];
        if (previousRun !== undefined) {
          for (let page = 1; page <= 10; page++) {
            const response = yield* get(
              `${prefix}/actions/runs/${previousRun.id}/jobs?per_page=100&filter=latest&page=${page}`,
            );
            const completed = yield* HttpClientResponse.schemaBodyJson(CompletedJobs)(
              response,
            ).pipe(Effect.mapError((error) => invalidResponse("read-ci-checks", error.message)));
            jobs.push(...completed.jobs);
            if (page * 100 >= completed.total_count) break;
          }
        }
        return jobs;
      });
      const hasFailedJob = Effect.fn("GitHubChecks.hasFailedJob")(function* (
        prefix: string,
        run: number,
      ) {
        yield* Effect.annotateCurrentSpan({ actionsRunId: run });
        for (let page = 1; page <= 10; page++) {
          const response = yield* get(
            `${prefix}/actions/runs/${run}/jobs?per_page=100&filter=latest&page=${page}`,
          );
          const jobs = yield* HttpClientResponse.schemaBodyJson(RunJobs)(response).pipe(
            Effect.mapError((error) => invalidResponse("read-ci-checks", error.message)),
          );
          if (
            jobs.jobs.some(
              ({ conclusion }) => conclusion !== null && FAILED_CONCLUSIONS.has(conclusion),
            )
          )
            return true;
          if (page * 100 >= jobs.total_count) break;
        }
        return false;
      });
      return {
        incompleteRuns: Effect.fn("GitHubChecks.incompleteRuns")(function* (
          repository: RepositoryName,
          head: CommitSha,
        ) {
          yield* Effect.annotateCurrentSpan({ repository, head });
          const { owner, name } = splitRepositoryName(repository);
          const prefix = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
          const latest = new Map<string, (typeof HeadWorkflowRuns.Type)["workflow_runs"][number]>();
          for (let page = 1; page <= 10; page++) {
            const response = yield* get(
              `${prefix}/actions/runs?head_sha=${head}&per_page=100&page=${page}`,
            );
            const runs = yield* HttpClientResponse.schemaBodyJson(HeadWorkflowRuns)(response).pipe(
              Effect.mapError((error) => invalidResponse("read-ci-checks", error.message)),
            );
            for (const run of runs.workflow_runs) {
              const key = `${run.workflow_id}:${run.event}`;
              const previous = latest.get(key);
              if (previous === undefined || previous.run_number < run.run_number)
                latest.set(key, run);
            }
            if (page * 100 >= runs.total_count) break;
          }
          const incomplete: Array<IncompleteWorkflowRun> = [];
          for (const run of latest.values()) {
            if (
              run.status !== "completed" ||
              (run.conclusion !== "failure" && run.conclusion !== "cancelled")
            )
              continue;
            if (yield* hasFailedJob(prefix, run.id)) continue;
            incomplete.push(
              IncompleteWorkflowRun.make({
                id: run.id,
                workflow:
                  run.name === null || run.name === "" ? `workflow ${run.workflow_id}` : run.name,
                conclusion: run.conclusion,
                url: run.html_url,
              }),
            );
          }
          yield* Effect.logInfo("Read workflow runs on the head", {
            repository,
            head,
            workflows: latest.size,
            incomplete: incomplete.map(({ id }) => id),
          });
          return incomplete;
        }),
        pendingDetails: Effect.fn("GitHubChecks.pendingDetails")(function* (
          repository: RepositoryName,
          head: CommitSha,
        ) {
          yield* Effect.annotateCurrentSpan({ repository, head });
          const { owner, name } = splitRepositoryName(repository);
          const prefix = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
          const pending = (yield* checkRuns(prefix, head, PendingChecks)).filter(
            ({ status }) => status !== "completed",
          );
          const histories = new Map<
            string,
            ReadonlyArray<(typeof CompletedJobs.Type)["jobs"][number]>
          >();
          const now = yield* Clock.currentTimeMillis;
          return yield* Effect.forEach(pending.slice(0, 10), (check) =>
            Effect.gen(function* () {
              const run = check.details_url?.match(
                /\/actions\/runs\/(\d+)\/job\/\d+(?:\?|$)/u,
              )?.[1];
              const history =
                run === undefined || check.status !== "in_progress"
                  ? []
                  : yield* previousSuccessfulJobs(prefix, run, histories).pipe(
                      Effect.catch((error) =>
                        Effect.logWarning("CI duration history unavailable", {
                          repository,
                          head,
                          job: check.name,
                          errorTag: error._tag,
                        }).pipe(Effect.as([])),
                      ),
                    );
              if (run !== undefined && check.status === "in_progress") histories.set(run, history);
              const previous = history.find(
                ({ name, conclusion }) => name === check.name && conclusion === "success",
              );
              return PendingCheck.make({
                name: check.name,
                status: check.status,
                startedAt: Option.fromNullOr(check.started_at),
                elapsedMilliseconds: Option.fromNullOr(check.started_at).pipe(
                  Option.map((startedAt) => Math.max(0, now - DateTime.toEpochMillis(startedAt))),
                ),
                previousDurationMilliseconds:
                  previous?.started_at != null && previous.completed_at !== null
                    ? Option.some(
                        Math.max(
                          0,
                          DateTime.toEpochMillis(previous.completed_at) -
                            DateTime.toEpochMillis(previous.started_at),
                        ),
                      )
                    : Option.none(),
              });
            }),
          );
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
          const failed = (yield* checkRuns(prefix, head, Checks)).filter(
            ({ conclusion }) => conclusion !== null && FAILED_CONCLUSIONS.has(conclusion),
          );
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
