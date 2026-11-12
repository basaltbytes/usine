import { ItemNumber } from "@usine/core/item";
import { CommitSha, RepositoryName, splitRepositoryName } from "@usine/core/repository";
import {
  type Brand,
  Clock,
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Result,
  Schema,
} from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { GitHubApp } from "./github-app.ts";
import type { GitHubAppError } from "./error.ts";
import { queryGraphql } from "./graphql.ts";
import { retryTransientRequest } from "./retry.ts";
import { API_ROOT, authorized, invalidResponse, statusError, transportError } from "./http.ts";
import { ActionsJob, FAILED_CONCLUSIONS, failedStepsExcerpt } from "./actions-log.ts";

/**
 * The current PR head, whether the PR is open, and its CI state, including conflicts that prevent
 * checks from starting.
 */
export class CheckSnapshot extends Schema.Class<
  CheckSnapshot,
  Brand.Brand<"@usine/github/checks/CheckSnapshot">
>("CheckSnapshot")({
  head: CommitSha,
  pullRequestState: Schema.Literals(["open", "closed", "merged"]),
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

/** A check run or legacy commit status on a head that has not completed. */
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

/** The pending checks on a head, running jobs first, and the number of checks beyond the first ten. */
export class PendingCheckReport extends Schema.Class<
  PendingCheckReport,
  Brand.Brand<"@usine/github/checks/PendingCheckReport">
>("PendingCheckReport")({
  checks: Schema.Array(PendingCheck).check(Schema.isMaxLength(10)),
  omitted: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}) {}

const JobNames = Schema.Array(Schema.NonEmptyString);

/**
 * The only failed job of a workflow run and the jobs of that run that never finished, such as a
 * gate job that failed because the jobs it needs stayed queued.
 */
export class LoneJobFailure extends Schema.Class<
  LoneJobFailure,
  Brand.Brand<"@usine/github/checks/LoneJobFailure">
>("LoneJobFailure")({
  job: Schema.NonEmptyString,
  /** The jobs of the run that are queued or waiting; at least one. */
  unfinished: JobNames.check(Schema.isMinLength(1)),
}) {}

/**
 * The latest run of a workflow on a head that failed or was canceled although it didn't run in
 * full: none of its jobs failed, or its only failed job failed while other jobs never finished.
 */
export class IncompleteWorkflowRun extends Schema.Class<
  IncompleteWorkflowRun,
  Brand.Brand<"@usine/github/checks/IncompleteWorkflowRun">
>("IncompleteWorkflowRun")({
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  workflow: Schema.NonEmptyString,
  conclusion: Schema.Literals(["failure", "cancelled"]),
  url: Schema.NonEmptyString,
  /** The run's only failed job, or `None` if none of its jobs failed. */
  loneFailure: Schema.Option(LoneJobFailure).pipe(
    Schema.withConstructorDefault(Effect.succeedNone),
  ),
}) {}

/** The latest run of a workflow on a head that has not concluded yet. */
export class RunningWorkflowRun extends Schema.Class<
  RunningWorkflowRun,
  Brand.Brand<"@usine/github/checks/RunningWorkflowRun">
>("RunningWorkflowRun")({
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  workflow: Schema.NonEmptyString,
  status: Schema.NonEmptyString,
  url: Schema.NonEmptyString,
  /**
   * The run's only failed job while other jobs of the run are still queued, or `None` if no job
   * failed, several failed, or no other job is queued.
   */
  loneFailure: Schema.Option(LoneJobFailure).pipe(
    Schema.withConstructorDefault(Effect.succeedNone),
  ),
}) {}

/** The latest workflow runs on a head that either ran only in part or have not concluded. */
export class HeadWorkflowRunState extends Schema.Class<
  HeadWorkflowRunState,
  Brand.Brand<"@usine/github/checks/HeadWorkflowRunState">
>("HeadWorkflowRunState")({
  incomplete: Schema.Array(IncompleteWorkflowRun),
  running: Schema.Array(RunningWorkflowRun),
}) {}

const Head = Schema.Struct({
  repository: Schema.NullOr(
    Schema.Struct({
      pullRequest: Schema.NullOr(
        Schema.Struct({
          state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
          headRefOid: CommitSha,
          headRef: Schema.NullOr(
            Schema.Struct({ target: Schema.NullOr(Schema.Struct({ oid: CommitSha })) }),
          ),
          mergeable: Schema.Literals(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
          statusCheckRollup: Schema.NullOr(Schema.Struct({ state: Schema.String })),
        }),
      ),
    }),
  ),
});
const HEAD_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { state headRefOid headRef { target { oid } } mergeable statusCheckRollup { state } }
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

const PendingCheckRuns = Schema.Struct({
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
const WorkflowRun = Schema.Struct({
  workflow_id: Schema.Int.check(Schema.isGreaterThan(0)),
  event: Schema.NonEmptyString,
});
const WorkflowRuns = Schema.Struct({
  workflow_runs: Schema.Array(Schema.Struct({ id: Schema.Int.check(Schema.isGreaterThan(0)) })),
});
const CompletedJobs = Schema.Struct({
  total_count: Schema.Int,
  jobs: Schema.Array(
    Schema.Struct({
      name: Schema.NonEmptyString,
      status: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
      started_at: Schema.NullOr(Schema.DateTimeUtcFromString),
      completed_at: Schema.NullOr(Schema.DateTimeUtcFromString),
    }),
  ),
});
type CompletedJob = (typeof CompletedJobs.Type)["jobs"][number];
type PendingCheckRun = (typeof PendingCheckRuns.Type)["check_runs"][number];

const PENDING_CHECK_LIMIT = 10;
const jobDuration = (job: CompletedJob) =>
  job.started_at !== null && job.completed_at !== null
    ? Option.some(
        Math.max(
          0,
          DateTime.toEpochMillis(job.completed_at) - DateTime.toEpochMillis(job.started_at),
        ),
      )
    : Option.none();

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
type HeadWorkflowRun = (typeof HeadWorkflowRuns.Type)["workflow_runs"][number];

const isFailedJob = ({ conclusion }: CompletedJob) =>
  conclusion !== null && FAILED_CONCLUSIONS.has(conclusion);

/**
 * Returns the only failed job of a run with the jobs that never finished, or `None`. In a run that
 * has not concluded, a job in progress may still finish, so only queued or waiting jobs count.
 */
const loneFailure = (jobs: ReadonlyArray<CompletedJob>, concluded: boolean) => {
  const failed = jobs.filter(isFailedJob);
  const [job] = failed;
  if (failed.length !== 1 || job === undefined) return Option.none();
  const unfinished = jobs
    .filter(({ status }) =>
      concluded ? status !== "completed" : status !== "completed" && status !== "in_progress",
    )
    .map(({ name }) => name);
  return unfinished.length === 0
    ? Option.none()
    : Option.some(LoneJobFailure.make({ job: job.name, unfinished }));
};

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
    /**
     * Reads the check runs on `head` that have not completed, or its pending commit statuses
     * when it has no such check run. The report lists running jobs first. For each running
     * Actions job, it adds the job's duration in the latest successful run of the same workflow
     * and event. Duration history reads stop at `historyDeadline` or at a rate limit; jobs
     * without a history read report no previous duration.
     */
    readonly pendingDetails: (
      repository: RepositoryName,
      head: CommitSha,
      historyDeadline: DateTime.Utc,
    ) => Effect.Effect<PendingCheckReport, GitHubAppError>;
    /**
     * Reads the latest run of each workflow and event on `head`. `incomplete` holds runs that
     * concluded `failure` or `cancelled` although they didn't run in full: none of their jobs
     * failed, such as a run whose jobs GitHub Actions never created, or their only failed job
     * failed while other jobs never finished, such as a gate job whose needed jobs stayed queued.
     * `running` holds runs that have not concluded yet, which can outlast their last created job
     * while the check rollup already reads green, or stay queued when Actions stalls.
     */
    readonly workflowRuns: (
      repository: RepositoryName,
      head: CommitSha,
    ) => Effect.Effect<HeadWorkflowRunState, GitHubAppError>;
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
      const paginate = Effect.fn("GitHubChecks.paginate")(function* <
        P extends { readonly total_count: number },
        A,
      >(
        path: string,
        schema: Schema.Codec<P, unknown, never, unknown>,
        items: (page: P) => ReadonlyArray<A>,
      ) {
        yield* Effect.annotateCurrentSpan({ path });
        const all: Array<A> = [];
        const separator = path.includes("?") ? "&" : "?";
        for (let page = 1; page <= 10; page++) {
          const response = yield* get(`${path}${separator}per_page=100&page=${page}`);
          const body = yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
            Effect.mapError((error) => invalidResponse("read-ci-checks", error.message)),
          );
          all.push(...items(body));
          if (page * 100 >= body.total_count) break;
        }
        return all;
      });
      const checkRuns = <C>(
        prefix: string,
        head: CommitSha,
        schema: Schema.Codec<
          { readonly total_count: number; readonly check_runs: ReadonlyArray<C> },
          unknown,
          never,
          unknown
        >,
      ) =>
        paginate(
          `${prefix}/commits/${head}/check-runs?filter=latest`,
          schema,
          ({ check_runs }) => check_runs,
        );
      const runJobs = (prefix: string, run: number) =>
        paginate(
          `${prefix}/actions/runs/${run}/jobs?filter=latest`,
          CompletedJobs,
          ({ jobs }) => jobs,
        );
      const previousSuccessfulJobs = Effect.fn("GitHubChecks.previousSuccessfulJobs")(function* (
        prefix: string,
        run: string,
      ) {
        yield* Effect.annotateCurrentSpan({ prefix, run });
        const metadata = yield* get(`${prefix}/actions/runs/${run}`);
        const workflow = yield* HttpClientResponse.schemaBodyJson(WorkflowRun)(metadata).pipe(
          Effect.mapError((error) => invalidResponse("read-ci-checks", error.message)),
        );
        const response = yield* get(
          `${prefix}/actions/workflows/${workflow.workflow_id}/runs?status=success&event=${encodeURIComponent(workflow.event)}&per_page=1`,
        );
        const previous = yield* HttpClientResponse.schemaBodyJson(WorkflowRuns)(response).pipe(
          Effect.mapError((error) => invalidResponse("read-ci-checks", error.message)),
        );
        const previousRun = previous.workflow_runs[0];
        return previousRun === undefined ? [] : yield* runJobs(prefix, previousRun.id);
      });
      const commitStatuses = Effect.fn("GitHubChecks.commitStatuses")(function* (
        prefix: string,
        head: CommitSha,
      ) {
        const response = yield* get(`${prefix}/commits/${head}/status?per_page=100`);
        const { statuses } = yield* HttpClientResponse.schemaBodyJson(Statuses)(response).pipe(
          Effect.mapError((error) => invalidResponse("read-ci-checks", error.message)),
        );
        return statuses;
      });
      const pendingStatuses = (prefix: string, head: CommitSha) =>
        commitStatuses(prefix, head).pipe(
          Effect.map((statuses) =>
            statuses
              .filter(({ state }) => state === "pending")
              .map(({ context }): PendingCheckRun => ({
                name: context,
                status: "pending",
                started_at: null,
                details_url: null,
              })),
          ),
        );
      return {
        workflowRuns: Effect.fn("GitHubChecks.workflowRuns")(function* (
          repository: RepositoryName,
          head: CommitSha,
        ) {
          yield* Effect.annotateCurrentSpan({ repository, head });
          const { owner, name } = splitRepositoryName(repository);
          const prefix = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
          const latest = new Map<string, HeadWorkflowRun>();
          for (const run of yield* paginate(
            `${prefix}/actions/runs?head_sha=${head}`,
            HeadWorkflowRuns,
            ({ workflow_runs }) => workflow_runs,
          )) {
            const key = `${run.workflow_id}:${run.event}`;
            const previous = latest.get(key);
            if (previous === undefined || previous.run_number < run.run_number)
              latest.set(key, run);
          }
          const workflow = (run: HeadWorkflowRun) =>
            run.name === null || run.name === "" ? `workflow ${run.workflow_id}` : run.name;
          const incomplete: Array<IncompleteWorkflowRun> = [];
          const running: Array<RunningWorkflowRun> = [];
          for (const run of latest.values()) {
            if (run.status !== "completed") {
              const jobs = yield* runJobs(prefix, run.id);
              running.push(
                RunningWorkflowRun.make({
                  id: run.id,
                  workflow: workflow(run),
                  status: run.status === null || run.status === "" ? "unknown" : run.status,
                  url: run.html_url,
                  loneFailure: loneFailure(jobs, false),
                }),
              );
              continue;
            }
            if (run.conclusion !== "failure" && run.conclusion !== "cancelled") continue;
            const jobs = yield* runJobs(prefix, run.id);
            const lone = loneFailure(jobs, true);
            if (Option.isNone(lone) && jobs.some(isFailedJob)) continue;
            incomplete.push(
              IncompleteWorkflowRun.make({
                id: run.id,
                workflow: workflow(run),
                conclusion: run.conclusion,
                url: run.html_url,
                loneFailure: lone,
              }),
            );
          }
          yield* Effect.logInfo("Read workflow runs on the head", {
            repository,
            head,
            workflows: latest.size,
            incomplete: incomplete.map(({ id }) => id),
            running: running.map(({ id }) => id),
          });
          return HeadWorkflowRunState.make({ incomplete, running });
        }),
        pendingDetails: Effect.fn("GitHubChecks.pendingDetails")(function* (
          repository: RepositoryName,
          head: CommitSha,
          historyDeadline: DateTime.Utc,
        ) {
          yield* Effect.annotateCurrentSpan({ repository, head });
          const { owner, name } = splitRepositoryName(repository);
          const prefix = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
          const runs = (yield* checkRuns(prefix, head, PendingCheckRuns)).filter(
            ({ status }) => status !== "completed",
          );
          const pending: ReadonlyArray<PendingCheckRun> =
            runs.length > 0 ? runs : yield* pendingStatuses(prefix, head);
          const shown = [
            ...pending.filter(({ status }) => status === "in_progress"),
            ...pending.filter(({ status }) => status !== "in_progress"),
          ].slice(0, PENDING_CHECK_LIMIT);
          const jobRun = (check: PendingCheckRun) =>
            check.status === "in_progress"
              ? Option.fromNullishOr(
                  check.details_url?.match(/\/actions\/runs\/(\d+)\/job\/\d+(?:\?|$)/u)?.[1],
                )
              : Option.none();
          const historyRuns = [...new Set(shown.flatMap((check) => Option.toArray(jobRun(check))))];
          const histories = new Map<string, ReadonlyArray<CompletedJob>>();
          const now = yield* Clock.currentTimeMillis;
          // Each history read records its result at once, so the deadline keeps the reads that ended.
          const readHistories = Effect.gen(function* () {
            for (const run of historyRuns) {
              const result = yield* previousSuccessfulJobs(prefix, run).pipe(Effect.result);
              if (Result.isSuccess(result)) {
                histories.set(run, result.success);
                continue;
              }
              const error = result.failure;
              if (error._tag === "GitHubRateLimitError") {
                yield* Effect.logWarning(
                  "GitHub rate limit reached; the remaining CI duration history reads are skipped",
                  { repository, head, run, retryAt: error.retryAt },
                );
                return;
              }
              yield* Effect.logWarning("CI duration history unavailable", {
                repository,
                head,
                run,
                errorTag: error._tag,
                message: error.message,
              });
            }
          });
          if (historyRuns.length > 0) {
            const remaining = DateTime.toEpochMillis(historyDeadline) - now;
            const read =
              remaining > 0
                ? yield* readHistories.pipe(Effect.timeoutOption(Duration.millis(remaining)))
                : Option.none();
            if (Option.isNone(read))
              yield* Effect.logWarning(
                "CI duration history reads reached their deadline; the remaining jobs report no previous duration",
                { repository, head, read: histories.size, runs: historyRuns.length },
              );
          }
          const checks = shown.map((check) =>
            PendingCheck.make({
              name: check.name,
              status: check.status,
              startedAt: Option.fromNullOr(check.started_at),
              elapsedMilliseconds: Option.fromNullOr(check.started_at).pipe(
                Option.map((startedAt) => Math.max(0, now - DateTime.toEpochMillis(startedAt))),
              ),
              previousDurationMilliseconds: jobRun(check).pipe(
                Option.flatMap((run) =>
                  Option.fromNullishOr(
                    histories
                      .get(run)
                      ?.find(
                        ({ name, conclusion }) => name === check.name && conclusion === "success",
                      ),
                  ),
                ),
                Option.flatMap(jobDuration),
              ),
            }),
          );
          yield* Effect.logInfo("Read pending CI checks", {
            repository,
            head,
            source: runs.length > 0 ? "check-runs" : "commit-statuses",
            pending: pending.length,
            histories: histories.size,
          });
          return PendingCheckReport.make({ checks, omitted: pending.length - shown.length });
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
          const pullRequestState =
            pr.state === "OPEN" ? "open" : pr.state === "MERGED" ? "merged" : "closed";
          // GitHub's schema makes both `headRef` and its `target` nullable.
          const branchHead = pr.headRef?.target?.oid ?? pr.headRefOid;
          if (branchHead !== pr.headRefOid) {
            yield* Effect.logInfo("Pull request head lags its branch; CI remains pending", {
              repository,
              item,
              branchHead,
              pullRequestHead: pr.headRefOid,
            });
            return CheckSnapshot.make({ head: branchHead, pullRequestState, state: "pending" });
          }
          return CheckSnapshot.make({
            head: pr.headRefOid,
            pullRequestState,
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
            const statuses = yield* commitStatuses(prefix, head);
            const failures = statuses.filter(
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
