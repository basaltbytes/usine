import { jsonKey } from "@usine/core/json-key";
import { CompletionCheck } from "@usine/engine/completion-check";
import { assert, it } from "@effect/vitest";
// The retention assertion must run after Node’s check phase releases native async handles.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { setImmediate } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
// Synchronous Node path callbacks retain the host platform’s path semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { queryObjects } from "node:v8";
import { NodeServices } from "@effect/platform-node";
import { AgentFile } from "@usine/config/agent";
import { UsineConfig } from "@usine/config/factory";
import { LoadedInstance } from "@usine/config/instance";
import { LoopFile, PromptTemplate } from "@usine/config/loop";
import { ConfigParser } from "@usine/config/parser";
import { PullRequestTrigger } from "@usine/config/trigger";
import { AgentName, AgentPersona } from "@usine/core/agent";
import { Harness, ModelId } from "@usine/core/agent/brain";
import { AttemptTask } from "@usine/core/attempt";
import { runView } from "../src/operator/projection.ts";
import { runNeedsAttention } from "../src/board/items.ts";
import { CiPolicy } from "@usine/core/ci";
import { CycleGeneration, CycleLimit } from "@usine/core/cycle-budget";
import { DedupKey, Event, EventId } from "@usine/core/event";
import { InstanceDirectory } from "@usine/core/instance";
import { LoopName } from "@usine/core/loop";
import { CommitSha, RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { ItemNumber } from "@usine/core/item";
import { GitHubLabelName } from "@usine/core/label";
import * as RunState from "@usine/core/run/state";
import { ApprovalSource } from "@usine/core/run/approval";
import { StepName } from "@usine/core/step";
import { PullRequest, StepCompletion, StepResult } from "@usine/core/step/result";
import { WorkerName } from "@usine/core/worker";
import { CycleBudgets } from "@usine/engine/cycle-budget";
import { RunReader, type RunSnapshot } from "@usine/engine/run-reader";
import { LoopControl } from "@usine/engine/loop-control";
import { EnginePersistenceError, RunEngine, Submission } from "@usine/engine/engine";
import { layer as engineLayer } from "@usine/engine/local-sqlite";
import { StepExecutor } from "@usine/engine/step-executor";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { ExpressionEngine, Source } from "@usine/expression/expression-engine";
import {
  ActionsJobRef,
  CheckFailureEvidence,
  CheckSnapshot,
  FailedCheck,
  GitHubChecks,
  FailedWorkflowRun,
  HeadWorkflowRunState,
  PendingCheck,
  PendingCheckReport,
  RunningWorkflowRun,
  UnfinishedCheck,
  WorkflowJob,
} from "@usine/github/checks";
import { GitHubItemWriter, type ItemLabelMutation } from "@usine/github/item-writer";
import { GitHubApiError, GitHubRateLimitError } from "@usine/github/github-app";
import {
  ChangedPullRequest,
  ContentHash,
  GitHubPolling,
  GitHubItemNotFoundError,
  PullRequestPayload,
  PullRequestSnapshot,
  RepositoryChanges,
  RepositoryNotModified,
  RepositoryLabelCatalog,
} from "@usine/github/polling";
import {
  DateTime,
  Deferred,
  Effect,
  FileSystem,
  Fiber,
  Layer,
  Option,
  Ref,
  Schedule,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import { sqliteTempDirectory } from "../../../tooling/test/sqlite.mts";
import { triggerConditionLayer } from "../src/trigger-condition.ts";
import { fixedInstance } from "./support/current-instance.ts";
import { CurrentInstance } from "../src/current-instance/current-instance.ts";
import { CiMonitor } from "../src/ci.ts";
import { PollingTriggers } from "../src/polling-triggers.ts";
import { triggerSubmission, withCiInstructions } from "../src/trigger-submission.ts";
import { gitHubItemKey } from "../src/polling/repository-sync.ts";
import { inertLabelReconcilerLayer, unmovedBaseRefHead } from "./support/polling.ts";

const repository = RepositoryName.make("basaltbytes/usine");
const head = CommitSha.make("a".repeat(40));
// The CI run on #1193 whose gate job failed because the jobs it needs stayed queued.
const gateRunId = 43098104121;
const gateJob = ActionsJobRef.make({ runId: gateRunId, jobId: 9001 });
const job = (id: number, name: string, status: string, conclusion?: string) =>
  WorkflowJob.make({ id, name, status, conclusion: Option.fromUndefinedOr(conclusion) });
const failedCheck = (name: string, actionsJob?: ActionsJobRef) =>
  FailedCheck.make({ name, actionsJob: Option.fromNullishOr(actionsJob) });
const agent = AgentFile.make({
  name: AgentName.make("developer"),
  harness: Harness.make("codex"),
  model: ModelId.make("gpt-6.1-sol"),
  effort: "high",
  parentModel: Option.none(),
  parentEffort: Option.none(),
  persona: AgentPersona.make("Implement changes."),
});
const loop = LoopFile.make({
  name: LoopName.make("fix"),
  maxCycles: CycleLimit.make(2),
  trigger: PullRequestTrigger.make({ on: "pr", if: Source.make("false") }),
  selector: Option.none(),
  approval: "none",
  step: StepName.make("run"),
  agent: agent.name,
  body: PromptTemplate.make("Fix the failing checks."),
});
const instance = Effect.gen(function* () {
  const decodedValue1 = yield* Schema.decodeEffect(UsineConfig)({
    version: 1,
    repos: [{ name: repository }],
  });
  return LoadedInstance.make({
    config: decodedValue1,
    agents: [agent],
    invalidAgents: [],
    loops: [loop],
    quarantinedLoops: [],
    warnings: [],
  });
});
const payload = Schema.decodeEffect(PullRequestPayload)({
  number: 815,
  title: "Change",
  body: "",
  url: `https://github.com/${repository}/pull/815`,
  state: "OPEN",
  isDraft: false,
  merged: false,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  mergedAt: null,
  author: null,
  baseRefName: "main",
  headRefName: "change",
  headRefOid: head,
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  reviewDecision: null,
  statusCheckRollup: { state: "FAILURE" },
  labels: { totalCount: 0, nodes: [] },
  reviewRequests: { totalCount: 0, nodes: [] },
  reviews: { totalCount: 0, nodes: [] },
  comments: { totalCount: 0, nodes: [] },
  closingIssuesReferences: { totalCount: 0, nodes: [] },
  reviewThreads: { totalCount: 0, nodes: [] },
});

const scenario = Effect.fn("test.ciScenario")(function* (
  timeoutSeconds: number,
  configured: LoadedInstance | undefined = undefined,
  fixCompletion: Effect.Effect<StepResult> = Effect.succeed(
    StepResult.make({ message: "Fixed", facts: [] }),
  ),
) {
  const fixtureInstance = yield* instance;
  const fixturePayload = yield* payload;
  const selectedInstance = configured ?? fixtureInstance;
  const fs = yield* FileSystem.FileSystem;
  const currentDirectory = yield* fs.makeTempDirectoryScoped({
    directory: sqliteTempDirectory(),
    prefix: "usine-ci-",
  });
  const directory = InstanceDirectory.make(currentDirectory);
  const currentInstance = yield* Ref.make(selectedInstance);
  const observed = yield* Ref.make(
    CheckSnapshot.make({ pullRequestState: "open", head, state: "pending" }),
  );
  const itemState = yield* Ref.make<"OPEN" | "CLOSED" | "MERGED" | "gone">("OPEN");
  const observationFailure = yield* Ref.make(Option.none<GitHubApiError | GitHubRateLimitError>());
  const snapshotFailure = yield* Ref.make(Option.none<GitHubApiError>());
  const snapshotIsDraft = yield* Ref.make(false);
  const mergeable = yield* Ref.make<PullRequestPayload["mergeable"]>("CONFLICTING");
  const tasks = yield* Ref.make<ReadonlyArray<string>>([]);
  const verifiedSubmissions = yield* Ref.make<ReadonlyArray<Submission>>([]);
  const mutations = yield* Ref.make<
    ReadonlyArray<{ readonly item: number; readonly mutation: ItemLabelMutation }>
  >([]);
  const result = StepResult.make({
    message: `[usine:awaiting-ci]\n${jsonKey({ pull_request: 815, head, fix_loop: "fix", timeout_seconds: timeoutSeconds, on_green: [{ item: 811, add: ["implemented"], remove: ["agent-in-progress"] }] })}`,
    facts: [
      PullRequest.make({
        number: 815,
        url: new URL(fixturePayload.url),
        head: Option.some(head),
      }),
    ],
  });
  const executor = Layer.succeed(StepExecutor)({
    workers: Effect.succeed([WorkerName.make("local")]),
    isLive: () => Effect.succeed(false),
    outcome: () => Effect.succeedNone,
    recover: () => Effect.succeed("found" as const),
    intervene: () => Effect.void,
    interrupt: () => Effect.void,
    occupy: (worker) => Effect.succeed({ worker, release: Effect.void }),
    sweep: Effect.void,
    discard: () => Effect.void,
    reserve: () => Effect.succeed({ worker: WorkerName.make("local"), release: Effect.void }),
    execute: (execution) =>
      Ref.updateAndGet(tasks, (all) => [...all, execution.task]).pipe(
        Effect.flatMap((all) => (all.length === 1 ? Effect.succeed(result) : fixCompletion)),
        Effect.map(StepCompletion.fromResult),
      ),
  });
  const pendingFailure = yield* Ref.make(Option.none<GitHubApiError>());
  const pendingStarted = yield* Deferred.make<void>();
  const pendingStalled = yield* Ref.make(false);
  const pendingHistoryDeadline = yield* Ref.make(Option.none<DateTime.Utc>());
  const workflowRuns = yield* Ref.make<
    Effect.Effect<HeadWorkflowRunState, GitHubApiError | GitHubRateLimitError>
  >(Effect.succeed(HeadWorkflowRunState.make({ failed: [], running: [] })));
  const unfinishedChecks = yield* Ref.make<ReadonlyArray<UnfinishedCheck>>([]);
  const failedChecks = yield* Ref.make<ReadonlyArray<FailedCheck>>([failedCheck("ci", gateJob)]);
  const failedStatuses = yield* Ref.make<ReadonlyArray<string>>([]);
  // Runs while `failures` reads the failed checks, such as a rerun that concludes meanwhile.
  const duringFailures = yield* Ref.make<Effect.Effect<void>>(Effect.void);
  // Runs just after `failures` or `failedStatuses` returns, such as a check that fails then.
  const afterFailures = yield* Ref.make<Effect.Effect<void>>(Effect.void);
  const afterFailedStatuses = yield* Ref.make<Effect.Effect<void>>(Effect.void);
  // Fails every commit-status read, as GitHub does without the `statuses` permission.
  const statusReadFailure = yield* Ref.make(Option.none<GitHubApiError>());
  const readStatuses = <A>(read: Effect.Effect<A>) =>
    Ref.get(statusReadFailure).pipe(
      Effect.flatMap(Option.match({ onNone: () => read, onSome: Effect.fail })),
    );
  const checks = Layer.succeed(GitHubChecks)({
    workflowRuns: () => Effect.flatten(Ref.get(workflowRuns)),
    unfinishedChecks: () => readStatuses(Ref.get(unfinishedChecks)),
    pendingDetails: (_repository, _head, historyDeadline) =>
      Effect.gen(function* () {
        yield* Ref.set(pendingHistoryDeadline, Option.some(historyDeadline));
        yield* Deferred.succeed(pendingStarted, undefined);
        if (yield* Ref.get(pendingStalled)) return yield* Effect.never;
        const failure = yield* Ref.get(pendingFailure);
        if (Option.isSome(failure)) return yield* failure.value;
        return PendingCheckReport.make({
          checks: [
            PendingCheck.make({
              name: "test (web)",
              status: "in_progress",
              startedAt: Option.some(DateTime.makeUnsafe("2026-11-05T19:54:00Z")),
              elapsedMilliseconds: Option.some(31 * 60000),
              previousDurationMilliseconds: Option.some(6 * 60000),
            }),
            PendingCheck.make({
              name: "test (lint)",
              status: "in_progress",
              startedAt: Option.none(),
              elapsedMilliseconds: Option.none(),
              previousDurationMilliseconds: Option.none(),
            }),
            PendingCheck.make({
              name: "test (server)",
              status: "queued",
              startedAt: Option.none(),
              elapsedMilliseconds: Option.none(),
              previousDurationMilliseconds: Option.none(),
            }),
          ],
          omitted: 2,
        });
      }),
    snapshot: () =>
      Effect.gen(function* () {
        const failure = yield* Ref.get(observationFailure);
        if (Option.isSome(failure)) return yield* failure.value;
        return yield* Ref.get(observed);
      }),
    failures: () =>
      Effect.flatten(Ref.get(duringFailures)).pipe(
        Effect.andThen(Ref.get(observed)),
        Effect.flatMap(({ state }) =>
          state === "conflict"
            ? Effect.die("A merge conflict has no failed check logs")
            : Ref.get(failedChecks).pipe(
                Effect.map((checks) =>
                  CheckFailureEvidence.make({
                    checks,
                    excerpt: checks.length === 0 ? "" : "TypeError: failing CI log",
                  }),
                ),
              ),
        ),
        Effect.tap(() => Effect.flatten(Ref.get(afterFailures))),
      ),
    failedStatuses: () =>
      readStatuses(Ref.get(failedStatuses)).pipe(
        Effect.map((contexts) =>
          CheckFailureEvidence.make({
            checks: contexts.map((context) => failedCheck(context)),
            excerpt: contexts.map((context) => `${context}\nBuild failed`).join("\n\n"),
          }),
        ),
        Effect.tap(() => Effect.flatten(Ref.get(afterFailedStatuses))),
      ),
  });
  const writer = Layer.succeed(GitHubItemWriter)({
    updateLabels: (_repository, item, mutation) =>
      Ref.update(mutations, (all) => [...all, { item, mutation }]).pipe(Effect.as([])),
  });
  const polling = Layer.succeed(GitHubPolling)({
    itemLabels: () => Effect.die("unused item labels"),
    baseRefHead: unmovedBaseRefHead,
    changes: (_repository, cursor) =>
      Effect.gen(function* () {
        if ((yield* Ref.get(itemState)) === "gone")
          return RepositoryNotModified.make({ cursor, nextPollAt: Option.none() });
        return RepositoryChanges.make({
          cursor,
          items: [
            ChangedPullRequest.make({
              number: fixturePayload.number,
              updatedAt: DateTime.makeUnsafe(fixturePayload.updatedAt),
            }),
          ],
          backlog: false,
          nextPollAt: Option.none(),
        });
      }),
    missingIssues: () => Effect.succeed([]),
    labels: () =>
      Effect.succeed(RepositoryLabelCatalog.make({ labels: [], entityTag: Option.none() })),
    snapshot: () =>
      Effect.gen(function* () {
        const failure = yield* Ref.get(snapshotFailure);
        if (Option.isSome(failure)) return yield* failure.value;
        const { head, state } = yield* Ref.get(observed);
        const currentState = yield* Ref.get(itemState);
        if (currentState === "gone")
          return yield* GitHubItemNotFoundError.make({
            operation: "fetch-pull-request-snapshot",
            item: 815,
            message: "Pull request no longer exists",
          });
        return PullRequestSnapshot.make({
          payload: PullRequestPayload.make({
            ...fixturePayload,
            state: currentState,
            isDraft: yield* Ref.get(snapshotIsDraft),
            merged: currentState === "MERGED",
            headRefOid: head,
            mergeable: state === "conflict" ? yield* Ref.get(mergeable) : "UNKNOWN",
            statusCheckRollup:
              state === "conflict" ? null : { state: state === "success" ? "SUCCESS" : "FAILURE" },
          }),
          contentHash: ContentHash.make("b".repeat(64)),
        });
      }),
  });
  const engine = engineLayer(directory).pipe(
    Layer.provide(executor),
    Layer.provide(
      Layer.succeed(CompletionCheck)({
        verify: (_attempt, submission) =>
          Ref.update(verifiedSubmissions, (all) => [...all, submission]),
      }),
    ),
    Layer.provide(
      triggerConditionLayer.pipe(
        Layer.provide(polling),
        Layer.provide(MarcbachmannCelLayer),
        Layer.provide(
          Layer.succeed(CurrentInstance)({
            ...fixedInstance(selectedInstance),
            get: Ref.get(currentInstance),
          }),
        ),
      ),
    ),
  );
  const parser = ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer));
  const dependencies = Layer.mergeAll(
    engine,
    checks,
    writer,
    polling,
    parser,
    MarcbachmannCelLayer,
  );
  const runtime = CiMonitor.layer.pipe(Layer.provideMerge(dependencies));
  return {
    dependencies,
    currentInstance,
    observed,
    itemState,
    observationFailure,
    snapshotFailure,
    snapshotIsDraft,
    pendingFailure,
    pendingStarted,
    pendingStalled,
    pendingHistoryDeadline,
    workflowRuns,
    unfinishedChecks,
    failedChecks,
    failedStatuses,
    duringFailures,
    afterFailures,
    afterFailedStatuses,
    statusReadFailure,
    mergeable,
    tasks,
    verifiedSubmissions,
    mutations,
    runtime,
    timeoutSeconds,
    directory,
  };
});

const openWait = Effect.fn("test.openCiWait")(function* (timeoutSeconds: number, sameLoop = false) {
  const fixturePayload = yield* payload;
  const fixtureInstance = yield* instance;
  const engine = yield* RunEngine;
  const expressions = yield* ExpressionEngine;

  const submission = yield* triggerSubmission(expressions, {
    loop: LoopFile.make({
      ...loop,
      name: sameLoop === true ? loop.name : LoopName.make("development"),
      ci: Option.some(CiPolicy.make({ fixLoop: loop.name, timeoutSeconds })),
    }),
    agent: agent.agent,
    parentModel: Option.none(),
    dedupKey: DedupKey.make("ci-development"),
    cycleGeneration: CycleGeneration.make(0),
    itemKey: gitHubItemKey(repository, 815),
    payload: fixturePayload,
    receivedAt: yield* DateTime.now,
    repository: fixtureInstance.config.repos[0] ?? assert.fail("missing repo"),
    revision: RepositoryRevision.make(head),
    task: AttemptTask.make("Implement"),
  });
  const accepted = yield* engine.submit(submission);
  assert(accepted._tag === "Claimed");
  yield* engine.inspect(accepted.runId).pipe(
    Effect.repeat({
      until: ({ run }) => run.state._tag === "AwaitingCi",
      schedule: Schedule.spaced("10 millis"),
    }),
    Effect.timeout("5 seconds"),
  );
  return accepted.runId;
});

it.live("reports CI observation failures after a repository is removed from configuration", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const setup = yield* scenario(3600);
      const removed = LoadedInstance.make({
        ...fixtureInstance,
        config: UsineConfig.make({ ...fixtureInstance.config, repos: [] }),
      });
      const failure = GitHubApiError.make({
        operation: "read-ci-checks",
        status: Option.some(403),
        message: "GitHub returned HTTP status 403",
      });
      yield* Effect.gen(function* () {
        const runId = yield* openWait(setup.timeoutSeconds);
        const polling = yield* PollingTriggers;
        yield* Ref.set(setup.observationFailure, Option.some(failure));

        assert.deepStrictEqual((yield* polling.poll(removed)).failures, []);

        assert.deepStrictEqual((yield* polling.poll(removed)).failures, []);
        const third = yield* polling.poll(removed);
        assert.strictEqual(third.failures.length, 1);
        assert.strictEqual(third.failures[0]?.repository, repository);
        assert.strictEqual(third.failures[0]?.errorTag, "GitHubApiError");
        assert.include(third.failures[0]?.message ?? "", failure.operation);

        assert.deepStrictEqual((yield* polling.poll(removed)).failures, third.failures);

        yield* Ref.set(
          setup.observationFailure,
          Option.some(
            GitHubRateLimitError.make({
              operation: failure.operation,
              message: "secondary rate limit",
              retryAt: yield* DateTime.now,
            }),
          ),
        );
        const paused = yield* polling.poll(removed);
        assert.deepStrictEqual(
          paused.failures.filter(({ errorTag }) => errorTag === "GitHubApiError"),
          third.failures,
        );
        yield* Ref.set(setup.observationFailure, Option.none());

        assert.deepStrictEqual((yield* polling.poll(removed)).failures, []);

        const decodedValue9 = yield* (yield* RunEngine).inspect(runId);
        assert.strictEqual(decodedValue9.run.state._tag, "AwaitingCi");

        yield* Ref.set(setup.observationFailure, Option.some(failure));

        assert.deepStrictEqual((yield* polling.poll(removed)).failures, []);

        assert.deepStrictEqual((yield* polling.poll(removed)).failures, []);

        assert.strictEqual((yield* polling.poll(removed)).failures.length, 1);
        yield* Ref.set(setup.observationFailure, Option.none());
        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "open", head, state: "success" }),
        );

        assert.deepStrictEqual((yield* polling.poll(removed)).failures, []);

        const decodedValue14 = yield* (yield* RunEngine).inspect(runId);
        assert.strictEqual(decodedValue14.run.state._tag, "Succeeded");

        assert.deepStrictEqual((yield* polling.poll(removed)).failures, []);
      }).pipe(
        Effect.provide(
          PollingTriggers.layer.pipe(
            Layer.provideMerge(Layer.merge(setup.runtime, inertLabelReconcilerLayer)),
          ),
        ),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("polling an open CI wait releases response bodies across six simulated hours", () =>
  Effect.gen(function* () {
    const fixtureInstance = yield* instance;
    class ResponseBody {
      readonly json: string;

      constructor(json: string) {
        this.json = json;
      }
    }

    const now = yield* TestClock.withLive(DateTime.now);
    yield* TestClock.setTime(DateTime.toEpochMillis(now));
    const setup = yield* scenario(8 * 60 * 60);
    yield* Effect.gen(function* () {
      const runId = yield* TestClock.withLive(openWait(setup.timeoutSeconds));
      const engine = yield* RunEngine;
      const monitor = yield* CiMonitor;
      const context = yield* Effect.context<never>();

      const poll = monitor.reconcile(fixtureInstance, Option.none()).pipe(
        Effect.andThen(engine.inspect(runId)),
        Effect.map(
          (snapshot) => new ResponseBody(jsonKey(runView(snapshot, new Set(), new Map()))),
        ),
        Effect.withSpan("http.request"),
        Effect.asVoid,
        Effect.provideContext(context),
      );
      for (let hour = 0; hour <= 6; hour++) {
        for (let request = 0; request < 8; request++) {
          yield* poll;
        }
        yield* Effect.promise(() => setImmediate());
        queryObjects(ResponseBody, { format: "count" });
        yield* Effect.promise(() => setImmediate());
        assert.strictEqual(queryObjects(ResponseBody, { format: "count" }), 0);

        assert.strictEqual((yield* engine.inspect(runId)).run.state._tag, "AwaitingCi");

        assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);

        assert.strictEqual((yield* Ref.get(setup.mutations)).length, 0);
        if (hour < 6) yield* TestClock.adjust("1 hour");
      }
    }).pipe(Effect.provide(setup.runtime));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("green CI observed after the deadline applies the recorded labels once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const setup = yield* scenario(1);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const monitor = yield* CiMonitor;
        const runId = yield* openWait(setup.timeoutSeconds);

        yield* monitor.reconcile(fixtureInstance, Option.none());

        assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);

        assert.strictEqual((yield* Ref.get(setup.mutations)).length, 0);
        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "open", head, state: "success" }),
        );
        yield* Effect.sleep("1100 millis");

        yield* monitor.reconcile(fixtureInstance, Option.none());

        yield* monitor.reconcile(fixtureInstance, Option.none());

        assert.strictEqual((yield* engine.inspect(runId)).run.state._tag, "Succeeded");

        assert.strictEqual((yield* Ref.get(setup.mutations)).length, 1);

        assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

const closedPullRequestCases = [
  { pullRequest: "closed", state: "pending" },
  { pullRequest: "closed", state: "failure" },
  { pullRequest: "closed", state: "conflict" },
  { pullRequest: "closed", state: "success" },
  { pullRequest: "merged", state: "pending" },
  { pullRequest: "merged", state: "failure" },
  { pullRequest: "merged", state: "conflict" },
] as const;

it.live.each(closedPullRequestCases)(
  "a pull request $pullRequest with $state CI ends the wait without labels, a fix, or an agent failure",
  ({ pullRequest, state }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixtureInstance = yield* instance;
        const setup = yield* scenario(3600);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const runId = yield* openWait(setup.timeoutSeconds);
          yield* Ref.set(
            setup.observed,
            CheckSnapshot.make({ pullRequestState: pullRequest, head, state }),
          );

          yield* (yield* CiMonitor).reconcile(fixtureInstance, Option.none());

          const settled = yield* engine.inspect(runId);
          const outcome = Option.getOrNull(settled.attempts.at(-1)?.outcome ?? Option.none());
          if (pullRequest === "merged") {
            assert.strictEqual(settled.run.state._tag, "Succeeded");
            assert.strictEqual(outcome?._tag, "Succeeded");
          } else {
            assert(settled.run.state._tag === "Canceled");
            assert.deepStrictEqual(
              settled.run.state.reason,
              RunState.PullRequestClosed.make({ pullRequest: ItemNumber.make(815) }),
            );
            assert.strictEqual(outcome?._tag, "Canceled");
          }
          const mutations = yield* Ref.get(setup.mutations);
          assert.deepStrictEqual(mutations, []);
          assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);
        }).pipe(Effect.provide(setup.runtime));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("green CI on a merged pull request applies the recorded labels", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const setup = yield* scenario(3600);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const runId = yield* openWait(setup.timeoutSeconds);
        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "merged", head, state: "success" }),
        );

        yield* (yield* CiMonitor).reconcile(fixtureInstance, Option.none());

        assert.strictEqual((yield* engine.inspect(runId)).run.state._tag, "Succeeded");
        assert.strictEqual((yield* Ref.get(setup.mutations)).length, 1);
        assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a force-pushed branch of a closed pull request supersedes the wait", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const setup = yield* scenario(3600);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const runId = yield* openWait(setup.timeoutSeconds);
        const pushed = CommitSha.make("c".repeat(40));
        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "closed", head: pushed, state: "pending" }),
        );

        yield* (yield* CiMonitor).reconcile(fixtureInstance, Option.none());

        const settled = yield* engine.inspect(runId);
        assert(settled.run.state._tag === "Canceled");
        assert.deepStrictEqual(
          settled.run.state.reason,
          RunState.HeadChanged.make({ head: pushed }),
        );
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each(["CLOSED", "MERGED"] as const)(
  "a pull request %s before its CI fix starts ends the wait without a fix or an agent failure",
  (itemState) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixtureInstance = yield* instance;
        const setup = yield* scenario(3600);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const runId = yield* openWait(setup.timeoutSeconds);
          yield* Ref.set(
            setup.observed,
            CheckSnapshot.make({ pullRequestState: "open", head, state: "failure" }),
          );
          yield* Ref.set(setup.itemState, itemState);

          yield* (yield* CiMonitor).reconcile(fixtureInstance, Option.none());

          const settled = yield* engine.inspect(runId);
          if (itemState === "MERGED") {
            assert.strictEqual(settled.run.state._tag, "Succeeded");
          } else {
            assert(settled.run.state._tag === "Canceled");
            assert.strictEqual(settled.run.state.reason._tag, "PullRequestClosed");
          }
          const mutations = yield* Ref.get(setup.mutations);
          assert.deepStrictEqual(mutations, []);
          assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);
        }).pipe(Effect.provide(setup.runtime));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

const partialRun = FailedWorkflowRun.make({
  id: 42672750451,
  workflow: "CI",
  conclusion: "failure",
  url: `https://github.com/${repository}/actions/runs/42672750451`,
});

it.live.each(["success", "failure"] as const)(
  "a partially created workflow run under a %s rollup needs the operator and starts no fix",
  (state) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixtureInstance = yield* instance;
        const setup = yield* scenario(3600);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const runId = yield* openWait(setup.timeoutSeconds);
          yield* Ref.set(
            setup.workflowRuns,
            Effect.succeed(HeadWorkflowRunState.make({ failed: [partialRun], running: [] })),
          );
          yield* Ref.set(setup.failedChecks, []);
          yield* Ref.set(
            setup.observed,
            CheckSnapshot.make({ pullRequestState: "open", head, state }),
          );

          yield* (yield* CiMonitor).reconcile(fixtureInstance, Option.none());

          const failed = yield* engine.inspect(runId);
          assert.strictEqual(failed.run.state._tag, "Failed");
          const outcome = Option.getOrNull(failed.attempts.at(-1)?.outcome ?? Option.none());
          assert(outcome?._tag === "Failed");
          assert.strictEqual(outcome.failure._tag, "InfraFailure");
          assert.include(outcome.failure.message, "CI (run 42672750451, failure)");
          assert.include(outcome.failure.message, partialRun.url);
          assert.include(outcome.failure.message, "Rerun these workflow runs");
          const mutations = yield* Ref.get(setup.mutations);
          assert.deepStrictEqual(mutations, []);
          assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);
          assert.strictEqual(runNeedsAttention(runView(failed, new Set(), new Map()), false), true);
        }).pipe(Effect.provide(setup.runtime));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

const runningRun = RunningWorkflowRun.make({
  id: 42672750451,
  workflow: "CI",
  status: "in_progress",
  url: `https://github.com/${repository}/actions/runs/42672750451`,
});

it.live("a workflow run that has not concluded keeps green CI waiting until the deadline", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const setup = yield* scenario(1);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const monitor = yield* CiMonitor;
        const runId = yield* openWait(setup.timeoutSeconds);
        yield* Ref.set(
          setup.workflowRuns,
          Effect.succeed(HeadWorkflowRunState.make({ failed: [], running: [runningRun] })),
        );
        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "open", head, state: "success" }),
        );

        yield* monitor.reconcile(fixtureInstance, Option.none());

        assert.strictEqual((yield* engine.inspect(runId)).run.state._tag, "AwaitingCi");
        assert.strictEqual((yield* Ref.get(setup.mutations)).length, 0);

        yield* Effect.sleep("1100 millis");
        yield* monitor.reconcile(fixtureInstance, Option.none());

        const timedOut = yield* engine.inspect(runId);
        assert.strictEqual(timedOut.run.state._tag, "Failed");
        const outcome = Option.getOrNull(timedOut.attempts.at(-1)?.outcome ?? Option.none());
        assert(outcome?._tag === "Failed");
        assert.include(outcome.failure.message, "CI (run 42672750451, in_progress)");
        assert.include(outcome.failure.message, runningRun.url);
        assert.strictEqual((yield* Ref.get(setup.mutations)).length, 0);
        assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

// The CI run on #1193 that GitHub Actions left queued with no jobs on 2026-11-11.
const queuedRun = RunningWorkflowRun.make({
  id: 43097310882,
  workflow: "CI",
  status: "queued",
  url: `https://github.com/${repository}/actions/runs/43097310882`,
});

const failedAttempt = (snapshot: RunSnapshot) => {
  const attempt = snapshot.attempts.at(-1) ?? assert.fail("missing attempt");
  const outcome = Option.getOrNull(attempt.outcome);
  assert(outcome?._tag === "Failed");
  return { attemptId: attempt.id, failure: outcome.failure };
};

it.live("a workflow run still queued at the deadline names the run and how to rerun it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const setup = yield* scenario(1);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const monitor = yield* CiMonitor;
        const runId = yield* openWait(setup.timeoutSeconds);
        yield* Ref.set(
          setup.workflowRuns,
          Effect.succeed(HeadWorkflowRunState.make({ failed: [], running: [queuedRun] })),
        );
        yield* monitor.reconcile(fixtureInstance, Option.none());
        assert.strictEqual((yield* engine.inspect(runId)).run.state._tag, "AwaitingCi");

        yield* Effect.sleep("1100 millis");
        yield* monitor.reconcile(fixtureInstance, Option.none());

        const stalled = yield* engine.inspect(runId);
        assert(stalled.run.state._tag === "Failed");
        assert.isTrue(Option.isSome(stalled.run.state.unfinishedCi));
        const { failure } = failedAttempt(stalled);
        assert.strictEqual(failure._tag, "InfraFailure");
        assert.include(failure.message, "GitHub Actions didn't finish these workflow runs");
        assert.include(failure.message, `CI (run 43097310882, queued): ${queuedRun.url}`);
        assert.include(failure.message, "Push a commit to start new runs");
        assert.include(failure.message, "rerun these workflow runs once GitHub allows it");
        assert.include(failure.message, "apply the completion labels from Needs attention");
        // The pending jobs tell a stalled run apart from a slow or hung job.
        assert.include(
          failure.message,
          "test (web) has been running for 31 min; its last successful run took 6 min.",
        );
        assert.strictEqual(runView(stalled, new Set(), new Map()).canApplyCiLabels, true);
        assert.strictEqual((yield* Ref.get(setup.mutations)).length, 0);
        assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

// The jobs of CI run 43098104121 on 2026-11-11: the gate job failed because the jobs it needs
// stayed queued after GitHub Actions stalled.
const gateJobs = [
  job(gateJob.jobId, "ci", "completed", "failure"),
  job(9002, "static", "queued"),
  job(9003, "test (rest)", "queued"),
  job(9004, "test (web)", "completed", "success"),
];

const gateRun = (state: "concluded" | "running", others: Array<RunningWorkflowRun> = []) => {
  const fields = {
    id: gateRunId,
    workflow: "CI",
    url: `https://github.com/${repository}/actions/runs/${gateRunId}`,
    jobs: gateJobs,
  };
  return state === "concluded"
    ? HeadWorkflowRunState.make({
        failed: [FailedWorkflowRun.make({ ...fields, conclusion: "failure" })],
        running: others,
      })
    : HeadWorkflowRunState.make({
        failed: [],
        running: [RunningWorkflowRun.make({ ...fields, status: "in_progress" }), ...others],
      });
};

it.live("a failed gate job with queued siblings is incomplete CI and starts no fix", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const setup = yield* scenario(1);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const monitor = yield* CiMonitor;
        const runId = yield* openWait(setup.timeoutSeconds);
        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "open", head, state: "failure" }),
        );
        // While the run is still going, the queued jobs might start, so the wait goes on.
        yield* Ref.set(setup.workflowRuns, Effect.succeed(gateRun("running")));
        yield* monitor.reconcile(fixtureInstance, Option.none());
        assert.strictEqual((yield* engine.inspect(runId)).run.state._tag, "AwaitingCi");

        yield* Ref.set(setup.workflowRuns, Effect.succeed(gateRun("concluded")));
        // The queued jobs of the concluded run stay pending check runs, but they can't start.
        yield* Ref.set(setup.unfinishedChecks, [
          UnfinishedCheck.make({
            name: "static",
            actionsJob: Option.some(ActionsJobRef.make({ runId: gateRunId, jobId: 9002 })),
          }),
          UnfinishedCheck.make({
            name: "test (rest)",
            actionsJob: Option.some(ActionsJobRef.make({ runId: gateRunId, jobId: 9003 })),
          }),
        ]);
        yield* monitor.reconcile(fixtureInstance, Option.none());

        const incomplete = yield* engine.inspect(runId);
        assert(incomplete.run.state._tag === "Failed");
        assert.isTrue(Option.isSome(incomplete.run.state.unfinishedCi));
        const { failure } = failedAttempt(incomplete);
        assert.strictEqual(failure._tag, "InfraFailure");
        assert.include(
          failure.message,
          "CI (run 43098104121, failure; job ci failed while static, test (rest) didn't finish)",
        );
        assert.include(failure.message, "Rerun these workflow runs");
        assert.notInclude(failure.message, "CI failed: ci");
        assert.strictEqual((yield* Ref.get(setup.mutations)).length, 0);
        assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a failed gate job whose siblings stay queued past the deadline is incomplete CI", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const setup = yield* scenario(1);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const runId = yield* openWait(setup.timeoutSeconds);
        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "open", head, state: "failure" }),
        );
        yield* Ref.set(setup.workflowRuns, Effect.succeed(gateRun("running")));
        yield* Effect.sleep("1100 millis");

        yield* (yield* CiMonitor).reconcile(fixtureInstance, Option.none());

        const incomplete = yield* engine.inspect(runId);
        assert.strictEqual(incomplete.run.state._tag, "Failed");
        const { failure } = failedAttempt(incomplete);
        // `CiIncomplete`, not the `CiTimedOut` of a run that Actions didn't finish.
        assert.include(failure.message, `GitHub Actions didn't run CI on head ${head} in full`);
        assert.notInclude(failure.message, "did not settle within");
        assert.include(failure.message, "CI (run 43098104121, in_progress; job ci failed");
        // The rollup is red, but the run still going lists its pending jobs.
        assert.include(
          failure.message,
          "test (web) has been running for 31 min; its last successful run took 6 min.",
        );
        assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a gate failure beside another failed job still starts the fix loop", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const setup = yield* scenario(3600);
      yield* Effect.gen(function* () {
        const runId = yield* openWait(setup.timeoutSeconds);
        yield* Ref.set(setup.failedChecks, [
          failedCheck("ci", gateJob),
          failedCheck("lint", ActionsJobRef.make({ runId: gateRunId, jobId: 9005 })),
        ]);
        yield* Ref.set(
          setup.workflowRuns,
          Effect.succeed(
            HeadWorkflowRunState.make({
              failed: [
                FailedWorkflowRun.make({
                  id: gateRunId,
                  workflow: "CI",
                  conclusion: "failure",
                  url: `https://github.com/${repository}/actions/runs/${gateRunId}`,
                  jobs: [...gateJobs, job(9005, "lint", "completed", "failure")],
                }),
              ],
              running: [],
            }),
          ),
        );
        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "open", head, state: "failure" }),
        );

        yield* (yield* CiMonitor).reconcile(fixtureInstance, Option.none());

        const source = yield* (yield* RunEngine).inspect(runId);
        assert(source.run.state._tag === "HandedOff");
        assert.include(source.run.state.reason, "CI failed: ci, lint.");
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a failed commit status beside a lone failed gate job still starts the fix loop", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const setup = yield* scenario(3600);
      yield* Effect.gen(function* () {
        const runId = yield* openWait(setup.timeoutSeconds);
        yield* Ref.set(setup.failedStatuses, ["external-ci"]);
        yield* Ref.set(setup.workflowRuns, Effect.succeed(gateRun("concluded")));
        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "open", head, state: "failure" }),
        );

        yield* (yield* CiMonitor).reconcile(fixtureInstance, Option.none());

        const source = yield* (yield* RunEngine).inspect(runId);
        assert(source.run.state._tag === "HandedOff");
        assert.include(source.run.state.reason, "CI failed: external-ci.");
        const fix = yield* (yield* RunEngine).inspect(source.run.state.fixRunId);
        assert.include(fix.task, "external-ci\nBuild failed");
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a gate failure from an earlier attempt of a rerun run keeps the wait pending", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const setup = yield* scenario(1);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const monitor = yield* CiMonitor;
        const runId = yield* openWait(setup.timeoutSeconds);
        // Attempt 2 of the run hasn't created its gate job yet, so the latest `ci` check run is
        // attempt 1's failure.
        yield* Ref.set(
          setup.workflowRuns,
          Effect.succeed(
            HeadWorkflowRunState.make({
              failed: [],
              running: [
                RunningWorkflowRun.make({
                  id: gateRunId,
                  workflow: "CI",
                  status: "in_progress",
                  url: `https://github.com/${repository}/actions/runs/${gateRunId}`,
                  jobs: [job(9101, "static", "in_progress"), job(9102, "test (web)", "queued")],
                }),
              ],
            }),
          ),
        );
        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "open", head, state: "failure" }),
        );

        yield* monitor.reconcile(fixtureInstance, Option.none());

        assert.strictEqual((yield* engine.inspect(runId)).run.state._tag, "AwaitingCi");
        assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);

        yield* Effect.sleep("1100 millis");
        yield* monitor.reconcile(fixtureInstance, Option.none());

        const stalled = yield* engine.inspect(runId);
        assert.strictEqual(stalled.run.state._tag, "Failed");
        const { failure } = failedAttempt(stalled);
        assert.include(failure.message, "GitHub Actions didn't finish these workflow runs");
        assert.include(failure.message, `CI (run ${gateRunId}, in_progress)`);
        assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a rerun that concludes while the failed checks are read keeps the wait pending", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const setup = yield* scenario(3600);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const runId = yield* openWait(setup.timeoutSeconds);
        // Attempt 2 of the run is going when the poll starts, and the latest `ci` check run is
        // still attempt 1's failure.
        yield* Ref.set(
          setup.workflowRuns,
          Effect.succeed(
            HeadWorkflowRunState.make({
              failed: [],
              running: [
                RunningWorkflowRun.make({
                  id: gateRunId,
                  workflow: "CI",
                  status: "in_progress",
                  url: `https://github.com/${repository}/actions/runs/${gateRunId}`,
                  jobs: [job(9101, "static", "completed", "success"), job(9102, "ci", "queued")],
                }),
              ],
            }),
          ),
        );
        // While the failed checks and their logs are read, attempt 2 concludes `success`, so the
        // run is no longer listed.
        yield* Ref.set(
          setup.duringFailures,
          Ref.set(
            setup.workflowRuns,
            Effect.succeed(HeadWorkflowRunState.make({ failed: [], running: [] })),
          ),
        );
        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "open", head, state: "failure" }),
        );

        yield* (yield* CiMonitor).reconcile(fixtureInstance, Option.none());

        assert.strictEqual((yield* engine.inspect(runId)).run.state._tag, "AwaitingCi");
        assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

// Worker image run 43099999999 concluded with one failed build beside a queued one, so its failed
// check is exempt and the rollup is red while CI run 43098104121 goes on.
const workerImageRunId = 43099999999;
const workerImageRun = (status: string, jobs: ReadonlyArray<WorkflowJob> = []) =>
  RunningWorkflowRun.make({
    id: workerImageRunId,
    workflow: "Worker image",
    status,
    url: `https://github.com/${repository}/actions/runs/${workerImageRunId}`,
    jobs,
  });
const workerImageJob = ActionsJobRef.make({ runId: workerImageRunId, jobId: 8001 });
const partialWorkerImageRun = FailedWorkflowRun.make({
  id: workerImageRunId,
  workflow: "Worker image",
  conclusion: "failure",
  url: `https://github.com/${repository}/actions/runs/${workerImageRunId}`,
  jobs: [
    job(workerImageJob.jobId, "build (amd64)", "completed", "failure"),
    job(8002, "build (arm64)", "queued"),
  ],
});
const gateRunWithJobs = (jobs: ReadonlyArray<WorkflowJob>) =>
  HeadWorkflowRunState.make({
    failed: [partialWorkerImageRun],
    running: [
      RunningWorkflowRun.make({
        id: gateRunId,
        workflow: "CI",
        status: "in_progress",
        url: `https://github.com/${repository}/actions/runs/${gateRunId}`,
        jobs,
      }),
    ],
  });

it.live.each(["while the failed checks are read", "before the poll"] as const)(
  "a gate job that fails %s, beside queued jobs, keeps the wait pending",
  (when) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixtureInstance = yield* instance;
        const setup = yield* scenario(3600);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const monitor = yield* CiMonitor;
          const runId = yield* openWait(setup.timeoutSeconds);
          const failedGate = gateRunWithJobs(gateJobs);
          // The run read lists `ci` in progress, and `ci` fails while the failed checks are read.
          yield* Ref.set(
            setup.workflowRuns,
            Effect.succeed(
              when === "while the failed checks are read"
                ? gateRunWithJobs([
                    job(gateJob.jobId, "ci", "in_progress"),
                    job(9002, "static", "queued"),
                    job(9003, "test (rest)", "queued"),
                    job(9004, "test (web)", "completed", "success"),
                  ])
                : failedGate,
            ),
          );
          yield* Ref.set(
            setup.duringFailures,
            Ref.set(setup.workflowRuns, Effect.succeed(failedGate)),
          );
          yield* Ref.set(setup.failedChecks, [
            failedCheck("build (amd64)", workerImageJob),
            failedCheck("ci", gateJob),
          ]);
          yield* Ref.set(
            setup.observed,
            CheckSnapshot.make({ pullRequestState: "open", head, state: "failure" }),
          );

          yield* monitor.reconcile(fixtureInstance, Option.none());

          assert.strictEqual((yield* engine.inspect(runId)).run.state._tag, "AwaitingCi");
          assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);

          // The next poll reads the failed gate beside its queued jobs and keeps waiting.
          yield* monitor.reconcile(fixtureInstance, Option.none());

          assert.strictEqual((yield* engine.inspect(runId)).run.state._tag, "AwaitingCi");
          assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);
        }).pipe(Effect.provide(setup.runtime));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a failed job named like a lone gate job in another workflow run starts the fix loop", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const setup = yield* scenario(3600);
      yield* Effect.gen(function* () {
        const runId = yield* openWait(setup.timeoutSeconds);
        yield* Ref.set(setup.failedChecks, [
          failedCheck("ci", ActionsJobRef.make({ runId: 43097310882, jobId: 7001 })),
        ]);
        yield* Ref.set(setup.workflowRuns, Effect.succeed(gateRun("concluded")));
        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "open", head, state: "failure" }),
        );

        yield* (yield* CiMonitor).reconcile(fixtureInstance, Option.none());

        const source = yield* (yield* RunEngine).inspect(runId);
        assert(source.run.state._tag === "HandedOff");
        assert.include(source.run.state.reason, "CI failed: ci.");
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("at the deadline, CI that ran only in part also names every run that didn't finish", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const setup = yield* scenario(1);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const runId = yield* openWait(setup.timeoutSeconds);
        // The second `pull_request` workflow stayed queued during the 2026-11-11 stall.
        yield* Ref.set(
          setup.workflowRuns,
          Effect.succeed(
            HeadWorkflowRunState.make({
              failed: [partialRun],
              running: [workerImageRun("queued")],
            }),
          ),
        );
        yield* Ref.set(setup.failedChecks, []);
        yield* Effect.sleep("1100 millis");

        yield* (yield* CiMonitor).reconcile(fixtureInstance, Option.none());

        const incomplete = yield* engine.inspect(runId);
        assert(incomplete.run.state._tag === "Failed");
        assert.isTrue(Option.isSome(incomplete.run.state.unfinishedCi));
        const { failure } = failedAttempt(incomplete);
        assert.strictEqual(failure._tag, "InfraFailure");
        assert.include(failure.message, `GitHub Actions didn't run CI on head ${head} in full`);
        assert.include(
          failure.message,
          `These workflow runs concluded without running in full: CI (run 42672750451, failure): ${partialRun.url}.`,
        );
        assert.include(
          failure.message,
          `GitHub Actions didn't finish these workflow runs within 1 seconds: Worker image (run ${workerImageRunId}, queued): https://github.com/${repository}/actions/runs/${workerImageRunId}.`,
        );
        assert.include(
          failure.message,
          "test (web) has been running for 31 min; its last successful run took 6 min.",
        );
        assert.strictEqual((yield* Ref.get(setup.mutations)).length, 0);
        assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "at the deadline, CI that ran only in part beside pending checks lists the pending jobs",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixtureInstance = yield* instance;
        const setup = yield* scenario(1);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const runId = yield* openWait(setup.timeoutSeconds);
          // No workflow run is still going, but the rollup is pending, so a check outside one is.
          yield* Ref.set(
            setup.workflowRuns,
            Effect.succeed(HeadWorkflowRunState.make({ failed: [partialRun], running: [] })),
          );
          yield* Ref.set(setup.failedChecks, []);
          yield* Effect.sleep("1100 millis");

          yield* (yield* CiMonitor).reconcile(fixtureInstance, Option.none());

          const incomplete = yield* engine.inspect(runId);
          assert.strictEqual(incomplete.run.state._tag, "Failed");
          const { failure } = failedAttempt(incomplete);
          assert.include(failure.message, `GitHub Actions didn't run CI on head ${head} in full`);
          assert.include(failure.message, `CI (run 42672750451, failure): ${partialRun.url}.`);
          assert.include(
            failure.message,
            "test (web) has been running for 31 min; its last successful run took 6 min.",
          );
          assert.include(failure.message, "test (server) is queued.");
          assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);
        }).pipe(Effect.provide(setup.runtime));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "a run that ran only in part waits for another workflow run, whose failure then reaches the fix loop",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixtureInstance = yield* instance;
        const setup = yield* scenario(3600);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const monitor = yield* CiMonitor;
          const runId = yield* openWait(setup.timeoutSeconds);
          yield* Ref.set(
            setup.observed,
            CheckSnapshot.make({ pullRequestState: "open", head, state: "failure" }),
          );
          yield* Ref.set(
            setup.workflowRuns,
            Effect.succeed(
              gateRun("concluded", [
                workerImageRun("in_progress", [
                  job(workerImageJob.jobId, "build (amd64)", "in_progress"),
                  job(8002, "build (arm64)", "in_progress"),
                ]),
              ]),
            ),
          );

          yield* monitor.reconcile(fixtureInstance, Option.none());

          assert.strictEqual((yield* engine.inspect(runId)).run.state._tag, "AwaitingCi");
          assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);

          yield* Ref.set(setup.failedChecks, [
            failedCheck("ci", gateJob),
            failedCheck("build (amd64)", workerImageJob),
          ]);
          yield* Ref.set(
            setup.workflowRuns,
            Effect.succeed(
              gateRun("concluded", [
                workerImageRun("in_progress", [
                  job(workerImageJob.jobId, "build (amd64)", "completed", "failure"),
                  job(8002, "build (arm64)", "in_progress"),
                ]),
              ]),
            ),
          );
          yield* monitor.reconcile(fixtureInstance, Option.none());

          const source = yield* engine.inspect(runId);
          assert(source.run.state._tag === "HandedOff");
          assert.include(source.run.state.reason, "CI failed: ci, build (amd64).");
          assert.strictEqual((yield* Ref.get(setup.tasks)).length, 2);
        }).pipe(Effect.provide(setup.runtime));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "a run that ran only in part waits for a pending check outside Actions, whose failure then reaches the fix loop",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixtureInstance = yield* instance;
        const setup = yield* scenario(3600);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const monitor = yield* CiMonitor;
          const runId = yield* openWait(setup.timeoutSeconds);
          yield* Ref.set(
            setup.observed,
            CheckSnapshot.make({ pullRequestState: "open", head, state: "failure" }),
          );
          yield* Ref.set(setup.workflowRuns, Effect.succeed(gateRun("concluded")));
          yield* Ref.set(setup.unfinishedChecks, [
            UnfinishedCheck.make({ name: "external-ci" }),
            UnfinishedCheck.make({
              name: "static",
              actionsJob: Option.some(ActionsJobRef.make({ runId: gateRunId, jobId: 9002 })),
            }),
          ]);

          yield* monitor.reconcile(fixtureInstance, Option.none());

          assert.strictEqual((yield* engine.inspect(runId)).run.state._tag, "AwaitingCi");
          assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);

          yield* Ref.set(setup.unfinishedChecks, []);
          yield* Ref.set(setup.failedStatuses, ["external-ci"]);
          yield* monitor.reconcile(fixtureInstance, Option.none());

          const source = yield* engine.inspect(runId);
          assert(source.run.state._tag === "HandedOff");
          assert.include(source.run.state.reason, "CI failed: external-ci.");
          assert.strictEqual((yield* Ref.get(setup.tasks)).length, 2);
        }).pipe(Effect.provide(setup.runtime));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "at the deadline, CI that ran only in part beside a pending check outside Actions is incomplete CI with the pending jobs",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixtureInstance = yield* instance;
        const setup = yield* scenario(1);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const monitor = yield* CiMonitor;
          const runId = yield* openWait(setup.timeoutSeconds);
          yield* Ref.set(
            setup.observed,
            CheckSnapshot.make({ pullRequestState: "open", head, state: "failure" }),
          );
          yield* Ref.set(setup.workflowRuns, Effect.succeed(gateRun("concluded")));
          yield* Ref.set(setup.unfinishedChecks, [
            UnfinishedCheck.make({ name: "deploy-preview" }),
          ]);

          yield* monitor.reconcile(fixtureInstance, Option.none());
          assert.strictEqual((yield* engine.inspect(runId)).run.state._tag, "AwaitingCi");

          yield* Effect.sleep("1100 millis");
          yield* monitor.reconcile(fixtureInstance, Option.none());

          const incomplete = yield* engine.inspect(runId);
          assert.strictEqual(incomplete.run.state._tag, "Failed");
          const { failure } = failedAttempt(incomplete);
          assert.include(failure.message, `GitHub Actions didn't run CI on head ${head} in full`);
          assert.include(failure.message, "job ci failed while static, test (rest) didn't finish");
          // The red rollup comes from the lone gate, but a check is still pending.
          assert.include(
            failure.message,
            "test (web) has been running for 31 min; its last successful run took 6 min.",
          );
          assert.strictEqual((yield* Ref.get(setup.mutations)).length, 0);
          assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);
        }).pipe(Effect.provide(setup.runtime));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each(["check run", "commit status"] as const)(
  "a %s that fails after the pending-check read, beside a lone failed gate, reaches the fix loop",
  (kind) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixtureInstance = yield* instance;
        const setup = yield* scenario(3600);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const monitor = yield* CiMonitor;
          const runId = yield* openWait(setup.timeoutSeconds);
          const name = kind === "check run" ? "deploy-preview" : "external-ci";
          yield* Ref.set(
            setup.observed,
            CheckSnapshot.make({ pullRequestState: "open", head, state: "failure" }),
          );
          yield* Ref.set(setup.workflowRuns, Effect.succeed(gateRun("concluded")));
          yield* Ref.set(setup.unfinishedChecks, [UnfinishedCheck.make({ name })]);
          // The check is still pending when its failure read returns, and fails right after it.
          const fail = Effect.all([
            Ref.set(setup.unfinishedChecks, []),
            kind === "check run"
              ? Ref.set(setup.failedChecks, [failedCheck("ci", gateJob), failedCheck(name)])
              : Ref.set(setup.failedStatuses, [name]),
          ]);
          yield* Ref.set(
            kind === "check run" ? setup.afterFailures : setup.afterFailedStatuses,
            fail,
          );

          yield* monitor.reconcile(fixtureInstance, Option.none());

          assert.strictEqual((yield* engine.inspect(runId)).run.state._tag, "AwaitingCi");
          assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);

          yield* monitor.reconcile(fixtureInstance, Option.none());

          const source = yield* engine.inspect(runId);
          assert(source.run.state._tag === "HandedOff");
          assert.include(
            source.run.state.reason,
            kind === "check run" ? "CI failed: ci, deploy-preview." : "CI failed: external-ci.",
          );
          assert.strictEqual((yield* Ref.get(setup.tasks)).length, 2);
        }).pipe(Effect.provide(setup.runtime));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a refused commit-status read leaves CI that ran only in part to the check runs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const setup = yield* scenario(3600);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const runId = yield* openWait(setup.timeoutSeconds);
        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "open", head, state: "failure" }),
        );
        yield* Ref.set(setup.workflowRuns, Effect.succeed(gateRun("concluded")));
        // GitHub answers the status read so without the `statuses` permission.
        yield* Ref.set(
          setup.statusReadFailure,
          Option.some(
            GitHubApiError.make({
              operation: "read-ci-checks",
              status: Option.some(403),
              message: "Resource not accessible by integration",
            }),
          ),
        );

        const { failures } = yield* (yield* CiMonitor).reconcile(fixtureInstance, Option.none());

        assert.deepStrictEqual(failures, []);
        const incomplete = yield* engine.inspect(runId);
        assert(incomplete.run.state._tag === "Failed");
        assert.isTrue(Option.isSome(incomplete.run.state.unfinishedCi));
        const { failure } = failedAttempt(incomplete);
        assert.include(failure.message, `GitHub Actions didn't run CI on head ${head} in full`);
        assert.strictEqual((yield* Ref.get(setup.mutations)).length, 0);
        assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a run that ran only in part under a green rollup waits for another workflow run", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const setup = yield* scenario(3600);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const monitor = yield* CiMonitor;
        const runId = yield* openWait(setup.timeoutSeconds);
        yield* Ref.set(setup.failedChecks, []);
        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "open", head, state: "success" }),
        );
        yield* Ref.set(
          setup.workflowRuns,
          Effect.succeed(
            HeadWorkflowRunState.make({
              failed: [partialRun],
              running: [workerImageRun("in_progress")],
            }),
          ),
        );

        yield* monitor.reconcile(fixtureInstance, Option.none());

        assert.strictEqual((yield* engine.inspect(runId)).run.state._tag, "AwaitingCi");

        yield* Ref.set(
          setup.workflowRuns,
          Effect.succeed(HeadWorkflowRunState.make({ failed: [partialRun], running: [] })),
        );
        yield* monitor.reconcile(fixtureInstance, Option.none());

        const incomplete = yield* engine.inspect(runId);
        assert.strictEqual(incomplete.run.state._tag, "Failed");
        const { failure } = failedAttempt(incomplete);
        assert.include(failure.message, "CI (run 42672750451, failure)");
        assert.notInclude(failure.message, "Worker image");
        assert.strictEqual((yield* Ref.get(setup.mutations)).length, 0);
        assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "a failed job beside a lone failed gate keeps its evidence over failed commit statuses",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixtureInstance = yield* instance;
        const setup = yield* scenario(3600);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const runId = yield* openWait(setup.timeoutSeconds);
          yield* Ref.set(setup.failedStatuses, ["external-ci"]);
          yield* Ref.set(setup.failedChecks, [
            failedCheck("ci", gateJob),
            failedCheck("build (amd64)", workerImageJob),
          ]);
          yield* Ref.set(
            setup.workflowRuns,
            Effect.succeed(
              gateRun("concluded", [
                workerImageRun("in_progress", [
                  job(workerImageJob.jobId, "build (amd64)", "completed", "failure"),
                  job(8002, "build (arm64)", "in_progress"),
                ]),
              ]),
            ),
          );
          yield* Ref.set(
            setup.observed,
            CheckSnapshot.make({ pullRequestState: "open", head, state: "failure" }),
          );

          yield* (yield* CiMonitor).reconcile(fixtureInstance, Option.none());

          const source = yield* engine.inspect(runId);
          assert(source.run.state._tag === "HandedOff");
          assert.include(source.run.state.reason, "CI failed: ci, build (amd64).");
          const fix = yield* engine.inspect(source.run.state.fixRunId);
          assert.include(fix.task, "TypeError: failing CI log");
          assert.notInclude(fix.task, "external-ci");
        }).pipe(Effect.provide(setup.runtime));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each([
  {
    case: "two failed jobs beside a queued job",
    state: "concluded",
    jobs: [
      job(gateJob.jobId, "ci", "completed", "failure"),
      job(9002, "static", "queued"),
      job(9004, "test (web)", "completed", "failure"),
    ],
    outcome: "HandedOff",
  },
  {
    case: "one failed job and every other job completed",
    state: "concluded",
    jobs: [
      job(gateJob.jobId, "ci", "completed", "failure"),
      job(9002, "static", "completed", "success"),
    ],
    outcome: "HandedOff",
  },
  {
    case: "a failed job beside a timed-out job and a queued job",
    state: "concluded",
    jobs: [
      job(gateJob.jobId, "ci", "completed", "failure"),
      job(9002, "static", "queued"),
      job(9003, "test (rest)", "completed", "timed_out"),
    ],
    outcome: "HandedOff",
  },
  {
    case: "a failed job beside a canceled job and a queued job",
    state: "concluded",
    jobs: [
      job(gateJob.jobId, "ci", "completed", "failure"),
      job(9002, "static", "queued"),
      job(9003, "test (rest)", "completed", "cancelled"),
    ],
    outcome: "HandedOff",
  },
  {
    case: "one failed job beside a job left in progress",
    state: "concluded",
    jobs: [job(gateJob.jobId, "ci", "completed", "failure"), job(9002, "static", "in_progress")],
    outcome: "Failed",
  },
  {
    case: "one failed job beside a job in progress",
    state: "running",
    jobs: [job(gateJob.jobId, "ci", "completed", "failure"), job(9002, "static", "in_progress")],
    outcome: "HandedOff",
  },
  {
    case: "one failed job beside a waiting job",
    state: "running",
    jobs: [job(gateJob.jobId, "ci", "completed", "failure"), job(9002, "static", "waiting")],
    outcome: "AwaitingCi",
  },
] as const)(
  "a gate failure in a $state run with $case ends as $outcome",
  ({ state, jobs, outcome }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixtureInstance = yield* instance;
        const setup = yield* scenario(3600);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const runId = yield* openWait(setup.timeoutSeconds);
          const fields = {
            id: gateRunId,
            workflow: "CI",
            url: `https://github.com/${repository}/actions/runs/${gateRunId}`,
            jobs,
          };
          yield* Ref.set(
            setup.workflowRuns,
            Effect.succeed(
              state === "concluded"
                ? HeadWorkflowRunState.make({
                    failed: [FailedWorkflowRun.make({ ...fields, conclusion: "failure" })],
                    running: [],
                  })
                : HeadWorkflowRunState.make({
                    failed: [],
                    running: [RunningWorkflowRun.make({ ...fields, status: "in_progress" })],
                  }),
            ),
          );
          yield* Ref.set(
            setup.observed,
            CheckSnapshot.make({ pullRequestState: "open", head, state: "failure" }),
          );

          yield* (yield* CiMonitor).reconcile(fixtureInstance, Option.none());

          const source = yield* engine.inspect(runId);
          assert.strictEqual(source.run.state._tag, outcome);
          assert.strictEqual((yield* Ref.get(setup.tasks)).length, outcome === "HandedOff" ? 2 : 1);
        }).pipe(Effect.provide(setup.runtime));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a later green run on the same head applies the recorded labels and resolves the run", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const setup = yield* scenario(1);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const monitor = yield* CiMonitor;
        const runId = yield* openWait(setup.timeoutSeconds);
        yield* Ref.set(
          setup.workflowRuns,
          Effect.succeed(HeadWorkflowRunState.make({ failed: [], running: [queuedRun] })),
        );
        yield* Effect.sleep("1100 millis");
        yield* monitor.reconcile(fixtureInstance, Option.none());
        const { attemptId } = yield* engine.inspect(runId).pipe(Effect.map(failedAttempt));

        // The rerun is still queued, so the labels wait.
        const pending = yield* Effect.flip(
          monitor.applyLabelsAfterGreen(runId, attemptId, Option.none()),
        );
        assert(pending._tag === "CiNotPassedError");
        assert.include(pending.message, `CI on head ${head} is still pending.`);

        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "open", head, state: "success" }),
        );
        const unfinished = yield* Effect.flip(
          monitor.applyLabelsAfterGreen(runId, attemptId, Option.none()),
        );
        assert(unfinished._tag === "CiNotPassedError");
        assert.include(unfinished.message, "CI (run 43097310882, queued)");
        assert.strictEqual((yield* Ref.get(setup.mutations)).length, 0);

        // A rerun that concluded without running in full leaves CI unfinished, too.
        yield* Ref.set(
          setup.workflowRuns,
          Effect.succeed(HeadWorkflowRunState.make({ failed: [partialRun], running: [] })),
        );
        const partial = yield* Effect.flip(
          monitor.applyLabelsAfterGreen(runId, attemptId, Option.none()),
        );
        assert(partial._tag === "CiNotPassedError");
        assert.include(partial.message, `CI (run 42672750451, failure): ${partialRun.url}`);
        assert.strictEqual((yield* Ref.get(setup.mutations)).length, 0);

        yield* Ref.set(
          setup.workflowRuns,
          Effect.succeed(HeadWorkflowRunState.make({ failed: [], running: [] })),
        );
        yield* monitor.applyLabelsAfterGreen(runId, attemptId, Option.none());

        const resolved = yield* engine.inspect(runId);
        assert.isTrue(Option.contains(resolved.resolvedFailureAttemptId, attemptId));
        const view = runView(resolved, new Set(), new Map());
        assert.strictEqual(view.canApplyCiLabels, false);
        assert.strictEqual(runNeedsAttention(view, false), false);
        assert.deepStrictEqual(
          (yield* Ref.get(setup.mutations)).map(({ item, mutation }) => ({
            item,
            add: mutation.add,
            remove: mutation.remove,
          })),
          [{ item: 811, add: ["implemented"], remove: ["agent-in-progress"] }],
        );
        const again = yield* Effect.flip(
          monitor.applyLabelsAfterGreen(runId, attemptId, Option.none()),
        );
        assert.strictEqual(again._tag, "RunOperationRejectedError");
        assert.strictEqual((yield* Ref.get(setup.mutations)).length, 1);
        assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("unreadable workflow runs leave Apply CI labels to the check rollup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const setup = yield* scenario(1);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const monitor = yield* CiMonitor;
        const runId = yield* openWait(setup.timeoutSeconds);
        // Workflow runs on a private repository need Actions access, which the App may lack.
        yield* Ref.set(
          setup.workflowRuns,
          Effect.fail(
            GitHubApiError.make({
              operation: "read-ci-checks",
              status: Option.some(403),
              message: "Resource not accessible by integration",
            }),
          ),
        );
        yield* Effect.sleep("1100 millis");
        yield* monitor.reconcile(fixtureInstance, Option.none());
        const timedOut = yield* engine.inspect(runId);
        assert(timedOut.run.state._tag === "Failed");
        assert.isTrue(Option.isSome(timedOut.run.state.unfinishedCi));
        const { attemptId } = failedAttempt(timedOut);

        const pending = yield* Effect.flip(
          monitor.applyLabelsAfterGreen(runId, attemptId, Option.none()),
        );
        assert(pending._tag === "CiNotPassedError");
        assert.include(pending.message, `CI on head ${head} is still pending.`);

        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "open", head, state: "success" }),
        );
        yield* monitor.applyLabelsAfterGreen(runId, attemptId, Option.none());

        const resolved = yield* engine.inspect(runId);
        assert.isTrue(Option.contains(resolved.resolvedFailureAttemptId, attemptId));
        assert.deepStrictEqual(
          (yield* Ref.get(setup.mutations)).map(({ item, mutation }) => ({
            item,
            add: mutation.add,
            remove: mutation.remove,
          })),
          [{ item: 811, add: ["implemented"], remove: ["agent-in-progress"] }],
        );
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a new head after an unfinished CI wait leaves its labels unapplied", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const setup = yield* scenario(1);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const monitor = yield* CiMonitor;
        const runId = yield* openWait(setup.timeoutSeconds);
        yield* Ref.set(
          setup.workflowRuns,
          Effect.succeed(HeadWorkflowRunState.make({ failed: [], running: [queuedRun] })),
        );
        yield* Effect.sleep("1100 millis");
        yield* monitor.reconcile(fixtureInstance, Option.none());
        const { attemptId } = yield* engine.inspect(runId).pipe(Effect.map(failedAttempt));
        const pushed = CommitSha.make("c".repeat(40));
        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "open", head: pushed, state: "success" }),
        );

        const moved = yield* Effect.flip(
          monitor.applyLabelsAfterGreen(runId, attemptId, Option.none()),
        );

        assert(moved._tag === "CiNotPassedError");
        assert.include(moved.message, `moved from head ${head} to ${pushed}`);
        assert.strictEqual((yield* Ref.get(setup.mutations)).length, 0);
        assert.isTrue(Option.isNone((yield* engine.inspect(runId)).resolvedFailureAttemptId));
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each(["closed", "merged"] as const)(
  "green CI on a %s pull request after an unfinished CI wait decides the labels like the wait",
  (pullRequestState) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixtureInstance = yield* instance;
        const setup = yield* scenario(1);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const monitor = yield* CiMonitor;
          const runId = yield* openWait(setup.timeoutSeconds);
          yield* Ref.set(
            setup.workflowRuns,
            Effect.succeed(HeadWorkflowRunState.make({ failed: [], running: [queuedRun] })),
          );
          yield* Effect.sleep("1100 millis");
          yield* monitor.reconcile(fixtureInstance, Option.none());
          const { attemptId } = yield* engine.inspect(runId).pipe(Effect.map(failedAttempt));
          yield* Ref.set(
            setup.workflowRuns,
            Effect.succeed(HeadWorkflowRunState.make({ failed: [], running: [] })),
          );
          yield* Ref.set(
            setup.observed,
            CheckSnapshot.make({ pullRequestState, head, state: "success" }),
          );

          const applied = yield* Effect.result(
            monitor.applyLabelsAfterGreen(runId, attemptId, Option.none()),
          );

          const resolved = (yield* engine.inspect(runId)).resolvedFailureAttemptId;
          if (pullRequestState === "closed") {
            assert(applied._tag === "Failure");
            assert(applied.failure._tag === "CiNotPassedError");
            assert.include(applied.failure.message, "was closed without a merge");
            assert.strictEqual((yield* Ref.get(setup.mutations)).length, 0);
            assert.isTrue(Option.isNone(resolved));
          } else {
            assert.strictEqual(applied._tag, "Success");
            assert.strictEqual((yield* Ref.get(setup.mutations)).length, 1);
            assert.isTrue(Option.contains(resolved, attemptId));
          }
        }).pipe(Effect.provide(setup.runtime));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("an earlier failed attempt doesn't apply the labels of a later unfinished CI wait", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const fixturePayload = yield* payload;
      const setup = yield* scenario(
        1,
        undefined,
        Effect.succeed(
          StepResult.make({
            message: `[usine:awaiting-ci]\n${jsonKey({ pull_request: 815, head, fix_loop: "fix", timeout_seconds: 1, on_green: [{ item: 811, add: ["retried"], remove: [] }] })}`,
            facts: [
              PullRequest.make({
                number: 815,
                url: new URL(fixturePayload.url),
                head: Option.some(head),
              }),
            ],
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const monitor = yield* CiMonitor;
        const runId = yield* openWait(setup.timeoutSeconds);
        yield* Ref.set(
          setup.workflowRuns,
          Effect.succeed(HeadWorkflowRunState.make({ failed: [], running: [queuedRun] })),
        );
        yield* Effect.sleep("1100 millis");
        yield* monitor.reconcile(fixtureInstance, Option.none());
        const earlier = yield* engine.inspect(runId).pipe(Effect.map(failedAttempt));

        yield* engine.retry(runId);
        yield* engine.inspect(runId).pipe(
          Effect.repeat({
            until: ({ run }) => run.state._tag === "AwaitingCi",
            schedule: Schedule.spaced("10 millis"),
          }),
          Effect.timeout("5 seconds"),
        );
        yield* Effect.sleep("1100 millis");
        yield* monitor.reconcile(fixtureInstance, Option.none());
        const later = yield* engine.inspect(runId).pipe(Effect.map(failedAttempt));
        assert.notStrictEqual(later.attemptId, earlier.attemptId);
        yield* Ref.set(
          setup.workflowRuns,
          Effect.succeed(HeadWorkflowRunState.make({ failed: [], running: [] })),
        );
        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "open", head, state: "success" }),
        );

        const stale = yield* Effect.flip(
          monitor.applyLabelsAfterGreen(runId, earlier.attemptId, Option.none()),
        );

        assert.strictEqual(stale._tag, "RunOperationRejectedError");
        assert.strictEqual((yield* Ref.get(setup.mutations)).length, 0);

        yield* monitor.applyLabelsAfterGreen(runId, later.attemptId, Option.none());

        assert.deepStrictEqual(
          (yield* Ref.get(setup.mutations)).map(({ item, mutation }) => ({
            item,
            add: mutation.add,
            remove: mutation.remove,
          })),
          [{ item: 811, add: ["retried"], remove: [] }],
        );
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("green CI passes once the workflow runs on the head have concluded", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const setup = yield* scenario(3600);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const monitor = yield* CiMonitor;
        const runId = yield* openWait(setup.timeoutSeconds);
        yield* Ref.set(
          setup.workflowRuns,
          Effect.succeed(HeadWorkflowRunState.make({ failed: [], running: [runningRun] })),
        );
        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "open", head, state: "success" }),
        );
        yield* monitor.reconcile(fixtureInstance, Option.none());
        assert.strictEqual((yield* engine.inspect(runId)).run.state._tag, "AwaitingCi");

        yield* Ref.set(
          setup.workflowRuns,
          Effect.succeed(HeadWorkflowRunState.make({ failed: [], running: [] })),
        );
        yield* monitor.reconcile(fixtureInstance, Option.none());

        assert.strictEqual((yield* engine.inspect(runId)).run.state._tag, "Succeeded");
        assert.strictEqual((yield* Ref.get(setup.mutations)).length, 1);
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a failed job routes CI to the fix loop even beside a partially created run", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const setup = yield* scenario(3600);
      yield* Effect.gen(function* () {
        const runId = yield* openWait(setup.timeoutSeconds);
        yield* Ref.set(
          setup.workflowRuns,
          Effect.succeed(HeadWorkflowRunState.make({ failed: [partialRun], running: [] })),
        );
        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "open", head, state: "failure" }),
        );

        yield* (yield* CiMonitor).reconcile(fixtureInstance, Option.none());

        const source = yield* (yield* RunEngine).inspect(runId);
        assert(source.run.state._tag === "HandedOff");
        assert.include(source.run.state.reason, "CI failed: ci.");
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a failed job routes CI to the fix loop while another workflow run is still running", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const setup = yield* scenario(3600);
      yield* Effect.gen(function* () {
        const runId = yield* openWait(setup.timeoutSeconds);
        yield* Ref.set(
          setup.workflowRuns,
          Effect.succeed(HeadWorkflowRunState.make({ failed: [], running: [runningRun] })),
        );
        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "open", head, state: "failure" }),
        );

        yield* (yield* CiMonitor).reconcile(fixtureInstance, Option.none());

        const source = yield* (yield* RunEngine).inspect(runId);
        assert(source.run.state._tag === "HandedOff");
        assert.include(source.run.state.reason, "CI failed: ci.");
        assert.strictEqual((yield* Ref.get(setup.tasks)).length, 2);
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a red rollup without a failed job waits for workflow runs that have not concluded", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const setup = yield* scenario(3600);
      yield* Effect.gen(function* () {
        const runId = yield* openWait(setup.timeoutSeconds);
        yield* Ref.set(
          setup.workflowRuns,
          Effect.succeed(HeadWorkflowRunState.make({ failed: [], running: [runningRun] })),
        );
        yield* Ref.set(setup.failedChecks, []);
        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "open", head, state: "failure" }),
        );

        yield* (yield* CiMonitor).reconcile(fixtureInstance, Option.none());

        assert.strictEqual((yield* (yield* RunEngine).inspect(runId)).run.state._tag, "AwaitingCi");
        assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("unreadable workflow runs leave green CI to the check rollup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const setup = yield* scenario(3600);
      yield* Effect.gen(function* () {
        const runId = yield* openWait(setup.timeoutSeconds);
        yield* Ref.set(
          setup.workflowRuns,
          Effect.fail(
            GitHubApiError.make({
              operation: "read-ci-checks",
              status: Option.some(403),
              message: "Resource not accessible by integration",
            }),
          ),
        );
        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "open", head, state: "success" }),
        );

        const result = yield* (yield* CiMonitor).reconcile(fixtureInstance, Option.none());

        assert.deepStrictEqual(result.failures, []);
        assert.strictEqual((yield* (yield* RunEngine).inspect(runId)).run.state._tag, "Succeeded");
        assert.strictEqual((yield* Ref.get(setup.mutations)).length, 1);
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a rate-limited workflow-run read defers green CI", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const setup = yield* scenario(3600);
      yield* Effect.gen(function* () {
        const runId = yield* openWait(setup.timeoutSeconds);
        yield* Ref.set(
          setup.workflowRuns,
          Effect.fail(
            GitHubRateLimitError.make({
              operation: "read-ci-checks",
              message: "secondary rate limit",
              retryAt: yield* DateTime.now,
            }),
          ),
        );
        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "open", head, state: "success" }),
        );

        const result = yield* (yield* CiMonitor).reconcile(fixtureInstance, Option.none());

        assert.deepStrictEqual(
          result.failures.map(({ errorTag }) => errorTag),
          ["GitHubRateLimitError"],
        );
        assert.strictEqual((yield* (yield* RunEngine).inspect(runId)).run.state._tag, "AwaitingCi");
        assert.strictEqual((yield* Ref.get(setup.mutations)).length, 0);
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a rate-limited workflow-run read fails Apply CI labels without applying them", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const setup = yield* scenario(1);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const monitor = yield* CiMonitor;
        const runId = yield* openWait(setup.timeoutSeconds);
        yield* Ref.set(
          setup.workflowRuns,
          Effect.succeed(HeadWorkflowRunState.make({ failed: [], running: [queuedRun] })),
        );
        yield* Effect.sleep("1100 millis");
        yield* monitor.reconcile(fixtureInstance, Option.none());
        const { attemptId } = yield* engine.inspect(runId).pipe(Effect.map(failedAttempt));

        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "open", head, state: "success" }),
        );
        yield* Ref.set(
          setup.workflowRuns,
          Effect.fail(
            GitHubRateLimitError.make({
              operation: "read-ci-checks",
              message: "secondary rate limit",
              retryAt: yield* DateTime.now,
            }),
          ),
        );
        const limited = yield* Effect.flip(
          monitor.applyLabelsAfterGreen(runId, attemptId, Option.none()),
        );

        assert.strictEqual(limited._tag, "GitHubRateLimitError");
        assert.strictEqual((yield* Ref.get(setup.mutations)).length, 0);
        const failed = yield* engine.inspect(runId);
        assert.isFalse(Option.contains(failed.resolvedFailureAttemptId, attemptId));
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a conflicting head without checks starts one fix before the CI deadline", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const setup = yield* scenario(3600);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const monitor = yield* CiMonitor;
        const sourceId = yield* openWait(setup.timeoutSeconds);
        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "open", head, state: "conflict" }),
        );

        yield* monitor.reconcile(fixtureInstance, Option.none());

        yield* monitor.reconcile(fixtureInstance, Option.none());
        const source = yield* engine.inspect(sourceId);
        assert(source.run.state._tag === "HandedOff");
        assert.include(source.run.state.reason, "conflicts with its base branch");
        const fix = yield* engine.inspect(source.run.state.fixRunId);
        assert.strictEqual(fix.run.loop, loop.name);
        assert.include(fix.task, "CONFLICTING and no checks exist");
        assert.include(fix.task, "Merge the base branch");
        assert.include(fix.task, head);
        yield* engine.drain;

        assert.strictEqual((yield* Ref.get(setup.tasks)).length, 2);

        assert.strictEqual((yield* Ref.get(setup.mutations)).length, 0);
        assert.strictEqual(runNeedsAttention(runView(source, new Set(), new Map()), false), false);
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("red CI observed after the deadline starts one budgeted fix with failure diagnostics", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const fixturePayload = yield* payload;
      const setup = yield* scenario(1);
      yield* Effect.gen(function* () {
        const monitor = yield* CiMonitor;
        const engine = yield* RunEngine;
        const runId = yield* openWait(setup.timeoutSeconds);
        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "open", head, state: "failure" }),
        );
        yield* Effect.sleep("1100 millis");

        yield* monitor.reconcile(fixtureInstance, Option.none());

        yield* monitor.reconcile(fixtureInstance, Option.none());
        yield* Ref.get(setup.tasks).pipe(
          Effect.repeat({
            until: (all) => all.length === 2,
            schedule: Schedule.spaced("10 millis"),
          }),
          Effect.timeout("5 seconds"),
        );
        const tasks = yield* Ref.get(setup.tasks);
        assert.include(tasks[1] ?? "", "ci");
        assert.include(tasks[1] ?? "", "TypeError: failing CI log");
        assert.strictEqual(tasks.length, 2);
        const settled = yield* engine.inspect(runId);
        assert(settled.run.state._tag === "HandedOff");
        assert.strictEqual(settled.run.state.head, head);
        assert.strictEqual(settled.run.state.fixLoop, loop.name);
        const fix = yield* engine.inspect(settled.run.state.fixRunId);
        assert.strictEqual(fix.run.loop, loop.name);
        const projected = runView(settled, new Set(), new Map());
        assert.strictEqual(runNeedsAttention(projected, false), false);

        assert.strictEqual((yield* Ref.get(setup.mutations)).length, 0);
        yield* engine.drain;
        const expressions = yield* ExpressionEngine;

        const another = yield* triggerSubmission(expressions, {
          loop: LoopFile.make({ ...loop, maxCycles: CycleLimit.make(1) }),
          agent: agent.agent,
          parentModel: Option.none(),
          dedupKey: DedupKey.make("another-fix"),
          cycleGeneration: CycleGeneration.make(0),
          itemKey: gitHubItemKey(repository, 815),
          payload: fixturePayload,
          receivedAt: yield* DateTime.now,
          repository: fixtureInstance.config.repos[0] ?? assert.fail("missing repo"),
          revision: RepositoryRevision.make(head),
          task: AttemptTask.make("Fix again"),
        });

        assert.strictEqual((yield* engine.submit(another))._tag, "CycleBlocked");

        assert.strictEqual((yield* (yield* CycleBudgets).asks).length, 1);
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each(["failure", "conflict"] as const)(
  "issue and PR completion actions survive an initial %s and successive CI fixes",
  (initialState) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixtureInstance = yield* instance;
        const fixturePayload = yield* payload;
        const heads = [CommitSha.make("b".repeat(40)), CommitSha.make("c".repeat(40))];
        const completedFixes = yield* Ref.make(0);

        const setup = yield* scenario(
          3600,
          fixtureInstance,
          Ref.updateAndGet(completedFixes, (count) => count + 1).pipe(
            Effect.map((count) => {
              const fixedHead = heads[count - 1] ?? assert.fail("unexpected fix attempt");
              return StepResult.make({
                message: `[usine:awaiting-ci]\n${jsonKey({ pull_request: 815, head: fixedHead, fix_loop: "fix", timeout_seconds: 3600, on_green: [{ item: 815, add: [count === 1 ? "fix-validated" : "ready-for-review"], remove: ["agent-review-findings"] }] })}`,
                facts: [
                  PullRequest.make({
                    number: 815,
                    url: new URL(fixturePayload.url),
                    head: Option.some(fixedHead),
                  }),
                ],
              });
            }),
          ),
        );
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const monitor = yield* CiMonitor;
          let sourceId = yield* openWait(setup.timeoutSeconds);
          let failedHead = head;
          for (const fixedHead of heads) {
            yield* Ref.set(
              setup.observed,
              CheckSnapshot.make({
                pullRequestState: "open",
                head: failedHead,
                state: failedHead === head ? initialState : "failure",
              }),
            );

            yield* monitor.reconcile(fixtureInstance, Option.none());
            const source = yield* engine.inspect(sourceId);
            assert(source.run.state._tag === "HandedOff");
            sourceId = source.run.state.fixRunId;
            const fix = yield* engine.inspect(sourceId).pipe(
              Effect.repeat({
                until: ({ run }) => run.state._tag === "AwaitingCi",
                schedule: Schedule.spaced("10 millis"),
              }),
              Effect.timeout("5 seconds"),
            );
            assert(fix.run.state._tag === "AwaitingCi");
            assert.strictEqual(fix.run.state.handoff.head, fixedHead);

            assert.strictEqual((yield* Ref.get(setup.mutations)).length, 0);
            failedHead = fixedHead;
          }
          yield* Ref.set(
            setup.observed,
            CheckSnapshot.make({ pullRequestState: "open", head: failedHead, state: "success" }),
          );

          yield* monitor.reconcile(fixtureInstance, Option.none());

          yield* monitor.reconcile(fixtureInstance, Option.none());

          assert.strictEqual((yield* engine.inspect(sourceId)).run.state._tag, "Succeeded");

          assert.deepStrictEqual(
            (yield* Ref.get(setup.mutations)).map(({ item, mutation }) => ({
              item,
              add: mutation.add,
              remove: mutation.remove,
            })),
            [
              { item: 811, add: ["implemented"], remove: ["agent-in-progress"] },
              { item: 815, add: ["fix-validated"], remove: ["agent-review-findings"] },
              { item: 815, add: ["ready-for-review"], remove: ["agent-review-findings"] },
            ],
          );

          assert.strictEqual((yield* Ref.get(setup.tasks)).length, 3);
        }).pipe(Effect.provide(setup.runtime));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a new push observed after the deadline supersedes the old head", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const setup = yield* scenario(1);
      yield* Effect.gen(function* () {
        const runId = yield* openWait(setup.timeoutSeconds);
        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({
            pullRequestState: "open",
            head: CommitSha.make("c".repeat(40)),
            state: "success",
          }),
        );
        yield* Effect.sleep("1100 millis");

        yield* (yield* CiMonitor).reconcile(fixtureInstance, Option.none());

        const decodedValue36 = yield* (yield* RunEngine).inspect(runId);
        assert.strictEqual(decodedValue36.run.state._tag, "Canceled");

        assert.strictEqual((yield* Ref.get(setup.mutations)).length, 0);

        assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each(["available", "unavailable"])(
  "a pending check timeout records infrastructure failure with %s job diagnostics",
  (diagnostics) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixtureInstance = yield* instance;
        const setup = yield* scenario(1);
        yield* Effect.gen(function* () {
          const runId = yield* openWait(setup.timeoutSeconds);
          yield* Ref.set(
            setup.workflowRuns,
            Effect.succeed(HeadWorkflowRunState.make({ failed: [], running: [runningRun] })),
          );
          if (diagnostics === "unavailable")
            yield* Ref.set(
              setup.pendingFailure,
              Option.some(
                GitHubApiError.make({
                  operation: "read-ci-checks",
                  status: Option.some(403),
                  message: "Forbidden",
                }),
              ),
            );
          yield* Effect.sleep("1100 millis");

          yield* (yield* CiMonitor).reconcile(fixtureInstance, Option.none());

          const failed = yield* (yield* RunEngine).inspect(runId);
          assert.strictEqual(failed.run.state._tag, "Failed");
          const outcome = Option.getOrNull(failed.attempts.at(-1)?.outcome ?? Option.none());
          assert(outcome?._tag === "Failed");
          assert.strictEqual(outcome.failure._tag, "InfraFailure");
          assert.include(
            outcome.failure.message,
            `CI (run 42672750451, in_progress): ${runningRun.url}`,
          );
          if (diagnostics === "available") {
            assert.include(
              outcome.failure.message,
              "test (web) has been running for 31 min; its last successful run took 6 min. test (lint) is running with no recorded start time; no previous successful duration is available. test (server) is queued. 2 more pending checks are not listed.",
            );
          } else {
            assert.include(outcome.failure.message, "Pending job diagnostics are unavailable.");
          }
          const mutations = yield* Ref.get(setup.mutations);
          assert.deepStrictEqual(mutations, []);

          assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);
        }).pipe(Effect.provide(setup.runtime));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a pending diagnostic read that never finishes still settles the CI timeout", () =>
  Effect.gen(function* () {
    const fixtureInstance = yield* instance;
    const setup = yield* scenario(1);
    yield* Effect.gen(function* () {
      const engine = yield* RunEngine;
      const runId = yield* TestClock.withLive(openWait(setup.timeoutSeconds));
      const waiting = yield* engine.inspect(runId);
      const endedAt = waiting.attempts.at(-1)?.endedAt ?? Option.none();
      assert(Option.isSome(endedAt));
      const timedOutAt = DateTime.toEpochMillis(endedAt.value) + 1001;
      yield* TestClock.setTime(timedOutAt);
      yield* Ref.set(setup.pendingStalled, true);
      const reconcile = yield* (yield* CiMonitor)
        .reconcile(fixtureInstance, Option.none())
        .pipe(Effect.forkChild);
      yield* Deferred.await(setup.pendingStarted);
      const historyDeadline = yield* Ref.get(setup.pendingHistoryDeadline);
      assert(Option.isSome(historyDeadline));
      assert.strictEqual(DateTime.toEpochMillis(historyDeadline.value), timedOutAt + 7000);
      yield* TestClock.adjust("10 seconds");
      const result = yield* Fiber.join(reconcile).pipe(
        Effect.timeout("1 second"),
        TestClock.withLive,
      );
      assert.deepStrictEqual(result.failures, []);
      const failed = yield* engine.inspect(runId);
      assert.strictEqual(failed.run.state._tag, "Failed");
      const outcome = Option.getOrNull(failed.attempts.at(-1)?.outcome ?? Option.none());
      assert(outcome?._tag === "Failed");
      assert.strictEqual(outcome.failure._tag, "InfraFailure");
      assert.include(outcome.failure.message, "Pending job diagnostics are unavailable.");
      const mutations = yield* Ref.get(setup.mutations);
      assert.deepStrictEqual(mutations, []);
      assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);
    }).pipe(Effect.provide(setup.runtime));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "a workflow-run read that never finishes at the deadline still settles the CI timeout",
  () =>
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const setup = yield* scenario(1);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const runId = yield* TestClock.withLive(openWait(setup.timeoutSeconds));
        const waiting = yield* engine.inspect(runId);
        const endedAt = waiting.attempts.at(-1)?.endedAt ?? Option.none();
        assert(Option.isSome(endedAt));
        yield* TestClock.setTime(DateTime.toEpochMillis(endedAt.value) + 1001);
        const started = yield* Deferred.make<void>();
        yield* Ref.set(
          setup.workflowRuns,
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        );
        const reconcile = yield* (yield* CiMonitor)
          .reconcile(fixtureInstance, Option.none())
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* TestClock.adjust("10 seconds");
        const result = yield* Fiber.join(reconcile).pipe(
          Effect.timeout("1 second"),
          TestClock.withLive,
        );
        assert.deepStrictEqual(result.failures, []);
        const failed = yield* engine.inspect(runId);
        assert.strictEqual(failed.run.state._tag, "Failed");
        const { failure } = failedAttempt(failed);
        assert.strictEqual(failure._tag, "InfraFailure");
        assert.include(failure.message, "test (web) has been running for 31 min");
        assert.strictEqual((yield* Ref.get(setup.mutations)).length, 0);
      }).pipe(Effect.provide(setup.runtime));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("CI fixes from their own loop are admitted before the source hands off", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const setup = yield* scenario(3600);
      yield* Effect.gen(function* () {
        const sourceId = yield* openWait(setup.timeoutSeconds, true);
        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "open", head, state: "failure" }),
        );

        yield* (yield* CiMonitor).reconcile(fixtureInstance, Option.none());
        yield* Ref.get(setup.tasks).pipe(
          Effect.repeat({
            until: (all) => all.length === 2,
            schedule: Schedule.spaced("10 millis"),
          }),
          Effect.timeout("5 seconds"),
        );
        yield* (yield* RunEngine).drain;

        assert.strictEqual((yield* Ref.get(setup.tasks)).length, 2);

        const source = yield* (yield* RunEngine).inspect(sourceId);
        assert.strictEqual(source.run.state._tag, "HandedOff");
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("an exhausted fix-loop budget leaves a failed source run needing attention", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const limited = LoadedInstance.make({
        ...fixtureInstance,
        loops: [LoopFile.make({ ...loop, maxCycles: CycleLimit.make(1) })],
      });
      const setup = yield* scenario(3600, limited);
      yield* Effect.gen(function* () {
        const runId = yield* openWait(setup.timeoutSeconds, true);
        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "open", head, state: "failure" }),
        );

        yield* (yield* CiMonitor).reconcile(limited, Option.none());

        const source = yield* (yield* RunEngine).inspect(runId);
        assert.strictEqual(source.run.state._tag, "Failed");
        const projected = runView(source, new Set(), new Map());
        assert.strictEqual(runNeedsAttention(projected, false), true);

        assert.strictEqual((yield* (yield* CycleBudgets).asks).length, 1);

        assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a failed admission of replayed CI fixes does not fail the CI poll", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const limited = LoadedInstance.make({
        ...fixtureInstance,
        loops: [LoopFile.make({ ...loop, maxCycles: CycleLimit.make(1) })],
      });
      const setup = yield* scenario(3600, limited);
      const failingAdmission = Layer.effect(
        RunEngine,
        Effect.map(RunEngine, (engine) =>
          RunEngine.of({
            ...engine,
            admitCiFixes: Effect.fail(
              EnginePersistenceError.make({ operation: "list pending queues", cause: "locked" }),
            ),
          }),
        ),
      ).pipe(Layer.provide(setup.dependencies));
      const runtime = CiMonitor.layer.pipe(
        Layer.provide(failingAdmission),
        Layer.provideMerge(setup.dependencies),
      );
      yield* Effect.gen(function* () {
        const budgets = yield* CycleBudgets;
        const monitor = yield* CiMonitor;
        yield* openWait(setup.timeoutSeconds, true);
        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "open", head, state: "failure" }),
        );
        yield* monitor.reconcile(limited, Option.none());
        const ask = (yield* budgets.asks)[0] ?? assert.fail("missing cycle ask");
        yield* budgets.reset(
          ask.id,
          Event.make({
            id: EventId.make("reset-failed-admission"),
            dedupKey: DedupKey.make("reset-failed-admission"),
            receivedAt: yield* DateTime.now,
            payload: {},
          }),
        );
        assert.strictEqual((yield* budgets.pendingResets).length, 1);

        const cycle = yield* monitor.reconcile(limited, Option.none());

        assert.deepStrictEqual(cycle.failures, []);
      }).pipe(Effect.provide(runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a pending cycle reset admits only the queued CI fixes, without a full reconcile", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const limited = LoadedInstance.make({
        ...fixtureInstance,
        loops: [LoopFile.make({ ...loop, maxCycles: CycleLimit.make(1) })],
      });
      const setup = yield* scenario(3600, limited);
      const admissions = yield* Ref.make(0);
      const narrowAdmission = Layer.effect(
        RunEngine,
        Effect.map(RunEngine, (engine) =>
          RunEngine.of({
            ...engine,
            reconcile: Effect.die("CiMonitor ran a full reconcile"),
            admitCiFixes: Ref.update(admissions, (count) => count + 1).pipe(
              Effect.andThen(engine.admitCiFixes),
            ),
          }),
        ),
      ).pipe(Layer.provide(setup.dependencies));
      const runtime = CiMonitor.layer.pipe(
        Layer.provide(narrowAdmission),
        Layer.provideMerge(setup.dependencies),
      );
      yield* Effect.gen(function* () {
        const budgets = yield* CycleBudgets;
        const monitor = yield* CiMonitor;
        yield* openWait(setup.timeoutSeconds, true);
        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "open", head, state: "failure" }),
        );
        yield* monitor.reconcile(limited, Option.none());
        const beforeReset = yield* Ref.get(admissions);
        assert.strictEqual(beforeReset, 0);
        const ask = (yield* budgets.asks)[0] ?? assert.fail("missing cycle ask");
        yield* budgets.reset(
          ask.id,
          Event.make({
            id: EventId.make("reset-narrow-admission"),
            dedupKey: DedupKey.make("reset-narrow-admission"),
            receivedAt: yield* DateTime.now,
            payload: {},
          }),
        );

        const cycle = yield* monitor.reconcile(limited, Option.none());

        assert.deepStrictEqual(cycle.failures, []);
        const afterReset = yield* Ref.get(admissions);
        assert.strictEqual(afterReset, 1);
      }).pipe(Effect.provide(runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a cycle reset revokes a blocked CI fix when the PR moves to a failing head", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const limited = LoadedInstance.make({
        ...fixtureInstance,
        loops: [LoopFile.make({ ...loop, maxCycles: CycleLimit.make(1) })],
      });
      const setup = yield* scenario(3600, limited);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const budgets = yield* CycleBudgets;
        const reader = yield* RunReader;
        yield* openWait(setup.timeoutSeconds, true);
        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "open", head, state: "failure" }),
        );
        yield* (yield* CiMonitor).reconcile(limited, Option.none());
        const ask = (yield* budgets.asks)[0] ?? assert.fail("missing cycle ask");
        const blocked = ask.blocks[0] ?? assert.fail("missing CI block");
        assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);

        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({
            pullRequestState: "open",
            head: CommitSha.make("c".repeat(40)),
            state: "failure",
          }),
        );
        const replayed = yield* budgets.reset(
          ask.id,
          Event.make({
            id: EventId.make("reset-superseded-ci-fix"),
            dedupKey: DedupKey.make("reset-superseded-ci-fix"),
            receivedAt: yield* DateTime.now,
            payload: {},
          }),
        );
        assert.deepStrictEqual(replayed, [blocked.eventId]);

        yield* engine.reconcile;
        yield* engine.drain;
        const fixId = yield* reader.runForEvent(DedupKey.make(blocked.eventId));
        assert(Option.isNone(fixId));
        assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);
        const remainingAsks = yield* budgets.asks;
        assert.deepStrictEqual(remainingAsks, []);

        yield* engine.reconcile;
        yield* engine.drain;
        const laterFixId = yield* reader.runForEvent(DedupKey.make(blocked.eventId));
        assert(Option.isNone(laterFixId));
        assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

const blockedFixInstance = (approval: "none" | "required") =>
  Effect.gen(function* () {
    const fixtureInstance = yield* instance;
    return LoadedInstance.make({
      ...fixtureInstance,
      loops: [
        LoopFile.make({
          ...loop,
          maxCycles: CycleLimit.make(1),
          trigger: PullRequestTrigger.make({
            on: "pr",
            if: Source.make(
              'item.state == "OPEN" && !item.merged && item.labels.nodes.exists(label, label.name == "agent-review-findings")',
            ),
          }),
          approval,
        }),
      ],
    });
  });

type CiScenario = Effect.Success<ReturnType<typeof scenario>>;

const withPolling = (setup: CiScenario) =>
  PollingTriggers.layer.pipe(
    Layer.provideMerge(Layer.merge(setup.runtime, inertLabelReconcilerLayer)),
  );

// Blocks a CI fix on the item's one-cycle budget, polls without the trigger label, and resets the
// budget, which replays the fix.
const resetBlockedCiFix = (setup: CiScenario, limited: LoadedInstance) =>
  Effect.gen(function* () {
    const budgets = yield* CycleBudgets;
    yield* openWait(setup.timeoutSeconds, true);
    yield* Ref.set(
      setup.observed,
      CheckSnapshot.make({ pullRequestState: "open", head, state: "failure" }),
    );
    yield* (yield* CiMonitor).reconcile(limited, Option.none());
    const ask = (yield* budgets.asks)[0] ?? assert.fail("missing cycle ask");
    const blocked = ask.blocks[0] ?? assert.fail("missing CI block");
    const answer = Event.make({
      id: EventId.make("reset-ci-fix"),
      dedupKey: DedupKey.make("reset-ci-fix"),
      receivedAt: yield* DateTime.now,
      payload: {},
    });
    assert.deepStrictEqual((yield* (yield* PollingTriggers).poll(limited)).failures, []);
    yield* budgets.reset(ask.id, answer);
    return { ask, blocked, answer };
  });

// Answers the reset again, which replays nothing, and checks that `tasks` attempts ran.
const answerResetAgain = (
  setup: CiScenario,
  limited: LoadedInstance,
  reset: Effect.Success<ReturnType<typeof resetBlockedCiFix>>,
  tasks: number,
) =>
  Effect.gen(function* () {
    const budgets = yield* CycleBudgets;
    yield* (yield* RunEngine).drain;
    yield* budgets.reset(reset.ask.id, reset.answer);
    yield* (yield* CiMonitor).reconcile(limited, Option.none());
    assert.strictEqual((yield* Ref.get(setup.tasks)).length, tasks);
    const remainingAsks = yield* budgets.asks;
    assert.deepStrictEqual(remainingAsks, []);
  });

it.live.each(["CLOSED", "MERGED", "gone"] as const)(
  "a cycle reset revokes a replayed CI fix waiting for approval when its pull request is %s",
  (state) =>
    Effect.scoped(
      Effect.gen(function* () {
        const limited = yield* blockedFixInstance("required");
        const setup = yield* scenario(3600, limited);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const reader = yield* RunReader;
          const reset = yield* resetBlockedCiFix(setup, limited);
          yield* engine.reconcile;
          const fixId = yield* reader.runForEvent(DedupKey.make(reset.blocked.eventId));
          assert(Option.isSome(fixId));
          yield* engine.inspect(fixId.value).pipe(
            Effect.repeat({
              until: ({ run }) => run.state._tag === "Waiting",
              schedule: Schedule.spaced("10 millis"),
            }),
            Effect.timeout("5 seconds"),
          );
          yield* Ref.set(setup.itemState, state);

          assert.deepStrictEqual((yield* (yield* PollingTriggers).poll(limited)).failures, []);
          yield* answerResetAgain(setup, limited, reset, 1);
          const revoked = yield* engine.inspect(fixId.value);
          assert(revoked.run.state._tag === "Canceled");
          assert.strictEqual(revoked.run.state.reason._tag, "Revoked");
          assert.deepStrictEqual(revoked.attempts, []);
        }).pipe(Effect.provide(withPolling(setup)));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each(["superseded", "success"] as const)(
  "a cycle reset drops a replayed CI fix without opening a run when the recheck finds %s checks",
  (state) =>
    Effect.scoped(
      Effect.gen(function* () {
        const limited = yield* blockedFixInstance("none");
        const setup = yield* scenario(3600, limited);
        yield* Effect.gen(function* () {
          const reset = yield* resetBlockedCiFix(setup, limited);
          yield* Ref.set(
            setup.observed,
            CheckSnapshot.make({
              pullRequestState: "open",
              head: state === "superseded" ? CommitSha.make("c".repeat(40)) : head,
              state: "success",
            }),
          );

          assert.deepStrictEqual((yield* (yield* PollingTriggers).poll(limited)).failures, []);
          yield* answerResetAgain(setup, limited, reset, 1);
          const fixId = yield* (yield* RunReader).runForEvent(DedupKey.make(reset.blocked.eventId));
          assert(Option.isNone(fixId));
        }).pipe(Effect.provide(withPolling(setup)));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a cycle reset opens a replayed CI fix without a trigger label once it is approved", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const limited = yield* blockedFixInstance("required");
      const setup = yield* scenario(3600, limited);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const reader = yield* RunReader;
        const reset = yield* resetBlockedCiFix(setup, limited);

        assert.deepStrictEqual((yield* (yield* PollingTriggers).poll(limited)).failures, []);
        const fixId = yield* reader.runForEvent(DedupKey.make(reset.blocked.eventId));
        assert(Option.isSome(fixId));
        const waiting = yield* engine.inspect(fixId.value).pipe(
          Effect.repeat({
            until: ({ run }) => run.state._tag === "Waiting" || run.state._tag === "Canceled",
            schedule: Schedule.spaced("10 millis"),
          }),
          Effect.timeout("5 seconds"),
        );
        assert.strictEqual(waiting.run.state._tag, "Waiting");
        assert.deepStrictEqual(waiting.attempts, []);
        yield* engine.approve(
          fixId.value,
          Event.make({
            id: EventId.make("approve-ci-fix"),
            dedupKey: DedupKey.make("approve-ci-fix"),
            receivedAt: yield* DateTime.now,
            payload: {},
          }),
          ApprovalSource.make({ channel: "ui", approver: Option.none() }),
        );
        yield* Ref.get(setup.tasks).pipe(
          Effect.repeat({
            until: (tasks) => tasks.length === 2,
            schedule: Schedule.spaced("10 millis"),
          }),
          Effect.timeout("5 seconds"),
        );

        yield* answerResetAgain(setup, limited, reset, 2);
        const fix = yield* engine.inspect(fixId.value);
        assert.strictEqual(fix.event.id, reset.blocked.eventId);
        assert.include((yield* Ref.get(setup.tasks))[1] ?? "", "TypeError: failing CI log");
      }).pipe(Effect.provide(withPolling(setup)));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a cycle reset keeps a replayed CI fix queued while its loop is paused", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const limited = yield* blockedFixInstance("none");
      const setup = yield* scenario(3600, limited);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const budgets = yield* CycleBudgets;
        const controls = yield* LoopControl;
        const reset = yield* resetBlockedCiFix(setup, limited);
        yield* controls.pause(loop.name);

        assert.deepStrictEqual((yield* (yield* PollingTriggers).poll(limited)).failures, []);
        assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);
        for (const pending of yield* budgets.pendingResets)
          yield* budgets.acknowledgeReset(pending);
        yield* controls.unpause(loop.name);
        yield* engine.admitCiFixes;
        yield* Ref.get(setup.tasks).pipe(
          Effect.repeat({
            until: (tasks) => tasks.length === 2,
            schedule: Schedule.spaced("10 millis"),
          }),
          Effect.timeout("5 seconds"),
        );

        yield* answerResetAgain(setup, limited, reset, 2);
        const fixId = yield* (yield* RunReader).runForEvent(DedupKey.make(reset.blocked.eventId));
        assert(Option.isSome(fixId));
        assert.strictEqual((yield* engine.inspect(fixId.value)).event.id, reset.blocked.eventId);
        assert.include((yield* Ref.get(setup.tasks))[1] ?? "", "TypeError: failing CI log");
      }).pipe(Effect.provide(withPolling(setup)));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each([
  { recorded: "none", current: "required", expected: "required", snapshotFails: false },
  { recorded: "required", current: "none", expected: "none", snapshotFails: false },
  { recorded: "none", current: "required", expected: "required", snapshotFails: true },
  {
    recorded: "required",
    current: Source.make("item.isDraft"),
    expected: "none",
    snapshotFails: false,
  },
  {
    recorded: "none",
    current: Source.make("!item.isDraft"),
    expected: "required",
    snapshotFails: false,
  },
] as const)(
  "a replayed CI fix recorded with approval $recorded takes approval $current from the current loop (first GitHub read fails: $snapshotFails)",
  ({ recorded, current, expected, snapshotFails }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixtureInstance = yield* instance;
        const configured = (approval: LoopFile["approval"]) =>
          LoadedInstance.make({
            ...fixtureInstance,
            loops: [LoopFile.make({ ...loop, maxCycles: CycleLimit.make(1), approval })],
          });
        const setup = yield* scenario(3600, configured(recorded));
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const budgets = yield* CycleBudgets;
          const reader = yield* RunReader;
          const sourceId = yield* openWait(setup.timeoutSeconds, true);
          yield* Ref.set(
            setup.observed,
            CheckSnapshot.make({ pullRequestState: "open", head, state: "failure" }),
          );
          yield* (yield* CiMonitor).reconcile(configured(recorded), Option.none());
          const source = yield* engine.inspect(sourceId);
          assert.strictEqual(source.run.state._tag, "Failed");
          const ask = (yield* budgets.asks)[0] ?? assert.fail("missing cycle ask");
          const blocked = ask.blocks[0] ?? assert.fail("missing CI block");
          const unlinked = yield* reader.ciFixRuns([sourceId]);
          assert.strictEqual(unlinked.size, 0);
          const edited = configured(current);
          yield* Ref.set(setup.currentInstance, edited);
          yield* Ref.set(setup.snapshotIsDraft, true);

          const replayed = yield* budgets.reset(
            ask.id,
            Event.make({
              id: EventId.make("reset-edited-ci-fix"),
              dedupKey: DedupKey.make("reset-edited-ci-fix"),
              receivedAt: yield* DateTime.now,
              payload: {},
            }),
          );
          if (snapshotFails) {
            yield* Ref.set(
              setup.snapshotFailure,
              Option.some(
                GitHubApiError.make({
                  operation: "fetch-pull-request-snapshot",
                  status: Option.some(503),
                  message: "GitHub is temporarily unavailable",
                }),
              ),
            );
            yield* engine.reconcile;
            // The fix stays queued until a recheck can read the pull request.
            const held = yield* reader.runForEvent(DedupKey.make(blocked.eventId));
            assert(Option.isNone(held));
            yield* Ref.set(setup.snapshotFailure, Option.none());
            yield* engine.reconcile;
          } else {
            const cycle = yield* (yield* PollingTriggers).poll(edited);
            assert.deepStrictEqual(cycle.failures, []);
          }

          assert.deepStrictEqual(replayed, [blocked.eventId]);
          const fixId = yield* reader.runForEvent(DedupKey.make(blocked.eventId));
          assert(Option.isSome(fixId));
          const fix = yield* engine.inspect(fixId.value).pipe(
            Effect.repeat({
              until: ({ run }) =>
                run.state._tag === "Waiting" ||
                run.state._tag === "Succeeded" ||
                run.state._tag === "Failed",
              schedule: Schedule.spaced("10 millis"),
            }),
            Effect.timeout("5 seconds"),
          );
          const reason = Option.getOrElse(fix.approvalReason, () => "");
          if (expected === "required") {
            assert.strictEqual(fix.run.state._tag, "Waiting");
            assert.deepStrictEqual(fix.attempts, []);
          } else {
            assert.strictEqual(fix.run.state._tag, "Succeeded");
            assert(Option.isNone(fix.approval));
            const tasks = yield* Ref.get(setup.tasks);
            assert.include(tasks[1] ?? "", "TypeError: failing CI log");
          }
          if (current === "required") assert.include(reason, "the loop requires approval");
          else if (current === "none") assert.include(reason, "the loop allows automatic starts");
          else {
            assert.include(reason, `condition evaluated to ${expected === "required"}`);
            assert.include(reason, current);
          }
          const linked = yield* reader.ciFixRuns([sourceId]);
          assert.strictEqual(linked.get(sourceId)?.runId, fixId.value);
          yield* engine.drain;
        }).pipe(
          Effect.provide(
            PollingTriggers.layer.pipe(
              Layer.provideMerge(Layer.merge(setup.runtime, inertLabelReconcilerLayer)),
            ),
          ),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each(["added", "removed", "changed"] as const)(
  "a replayed CI fix uses current settings and task instructions when CI is %s",
  (change) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixtureInstance = yield* instance;
        const oldPolicy = CiPolicy.make({ fixLoop: LoopName.make("old-fix"), timeoutSeconds: 60 });
        const newPolicy = CiPolicy.make({
          fixLoop: LoopName.make("new-fix"),
          timeoutSeconds: 7200,
        });
        const recorded = LoadedInstance.make({
          ...fixtureInstance,
          loops: [
            LoopFile.make({
              ...loop,
              maxCycles: CycleLimit.make(1),
              ci: change === "added" ? Option.none() : Option.some(oldPolicy),
            }),
          ],
        });
        const editedAgent = AgentFile.make({
          ...agent,
          name: AgentName.make("replacement"),
          model: ModelId.make("gpt-6-astra"),
          parentModel: Option.some(ModelId.make("gpt-6.1-sol")),
          persona: AgentPersona.make("Use the updated agent."),
        });
        const editedLoop = LoopFile.make({
          ...loop,
          agent: editedAgent.name,
          approval: "required",
          maxCycles: CycleLimit.make(4),
          permissions: "read",
          outcomeLabels: [GitHubLabelName.make("review-passed")],
          body: PromptTemplate.make(
            "This edited prompt must not replace the recorded failure task.",
          ),
          ci: change === "removed" ? Option.none() : Option.some(newPolicy),
        });
        const edited = LoadedInstance.make({
          ...fixtureInstance,
          agents: [editedAgent],
          loops: [editedLoop],
        });
        const setup = yield* scenario(3600, recorded);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const reader = yield* RunReader;
          const budgets = yield* CycleBudgets;
          const sourceId = yield* openWait(setup.timeoutSeconds, true);
          yield* Ref.set(
            setup.observed,
            CheckSnapshot.make({ pullRequestState: "open", head, state: "failure" }),
          );
          yield* (yield* CiMonitor).reconcile(recorded, Option.none());
          const ask = (yield* budgets.asks)[0] ?? assert.fail("missing cycle ask");
          const blocked = ask.blocks[0] ?? assert.fail("missing CI block");
          yield* Ref.set(setup.currentInstance, edited);
          yield* budgets.reset(
            ask.id,
            Event.make({
              id: EventId.make("reset-settings"),
              dedupKey: DedupKey.make("reset-settings"),
              receivedAt: yield* DateTime.now,
              payload: {},
            }),
          );
          yield* engine.reconcile;
          const fixId = yield* reader.runForEvent(DedupKey.make(blocked.eventId));
          assert(Option.isSome(fixId));
          const fix = yield* engine.inspect(fixId.value).pipe(
            Effect.repeat({
              until: ({ run }) => run.state._tag === "Waiting",
              schedule: Schedule.spaced("10 millis"),
            }),
            Effect.timeout("5 seconds"),
          );
          assert.deepStrictEqual(fix.agent, editedAgent.agent);
          assert.deepStrictEqual(fix.parentModel, editedAgent.parentModel);
          assert.strictEqual(fix.permissions, "read");
          assert.deepStrictEqual(fix.ciPolicy, editedLoop.ci);
          yield* engine.approve(
            fixId.value,
            Event.make({
              id: EventId.make("approve-current-settings"),
              dedupKey: DedupKey.make("approve-current-settings"),
              receivedAt: yield* DateTime.now,
              payload: {},
            }),
            ApprovalSource.make({ channel: "ui", approver: Option.none() }),
          );
          const verified = yield* Ref.get(setup.verifiedSubmissions).pipe(
            Effect.repeat({
              until: (all) => all.length > 0,
              schedule: Schedule.spaced("10 millis"),
            }),
            Effect.timeout("5 seconds"),
          );
          const saved = verified[0] ?? assert.fail("missing completion verification");
          assert.deepStrictEqual(saved.outcomeLabels, [GitHubLabelName.make("review-passed")]);
          assert.deepStrictEqual(saved.cycleLimit, Option.some(CycleLimit.make(4)));
          assert.deepStrictEqual(saved.agent, editedAgent.agent);
          assert.deepStrictEqual(saved.parentModel, editedAgent.parentModel);
          assert.strictEqual(saved.permissions, "read");
          assert.deepStrictEqual(saved.ciPolicy, editedLoop.ci);
          assert.strictEqual(saved.task, fix.task);
          assert.include(fix.task, "Fix the failing checks.");
          assert.include(fix.task, "TypeError: failing CI log");
          assert.include(fix.task, `Head: ${head}`);
          assert.notInclude(fix.task, "This edited prompt");
          assert.notInclude(fix.task, 'fix_loop ("old-fix")');
          assert.notInclude(fix.task, "timeout_seconds (60)");
          if (change === "removed") {
            assert.notInclude(fix.task, "[usine:awaiting-ci]");
            assert.notInclude(fix.task, "Do not apply completion labels");
            assert(Option.isNone(saved.ciInstructions));
          } else {
            assert(Option.isSome(saved.ciInstructions));
            assert(fix.task.endsWith(saved.ciInstructions.value));
            assert.include(saved.ciInstructions.value, 'fix_loop ("new-fix")');
            assert.include(fix.task, 'fix_loop ("new-fix")');
            assert.include(fix.task, "timeout_seconds (7200)");
            assert.include(fix.task, "Do not apply completion labels");
            assert.strictEqual(fix.task.split("After pushing, end with").length, 2);
          }
          assert.deepStrictEqual(saved.ciFailureHead, Option.some(head));
          const links = yield* reader.ciFixRuns([sourceId]);
          assert.strictEqual(links.get(sourceId)?.runId, fixId.value);
          yield* engine.drain;
        }).pipe(Effect.provide(setup.runtime));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a CI fix records the CI handoff instructions that end its task", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const policy = CiPolicy.make({ fixLoop: loop.name, timeoutSeconds: 3600 });
      const configured = LoadedInstance.make({
        ...fixtureInstance,
        loops: [LoopFile.make({ ...loop, ci: Option.some(policy) })],
      });
      const setup = yield* scenario(3600, configured);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const reader = yield* RunReader;
        // The source Run is in another Loop, so nothing holds the fix back: it is admitted when
        // it is recorded, with no recheck that could record its settings again.
        const sourceId = yield* openWait(setup.timeoutSeconds);
        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "open", head, state: "failure" }),
        );
        yield* (yield* CiMonitor).reconcile(configured, Option.none());
        const fixId =
          (yield* reader.ciFixRuns([sourceId])).get(sourceId)?.runId ??
          assert.fail("missing CI fix run");
        const row = yield* Effect.sync(() => {
          const database = new DatabaseSync(join(setup.directory, ".usine/runtime.sqlite"));
          try {
            return database
              .prepare(
                "SELECT task, ci_instructions FROM usine_trigger_events WHERE event_id = (SELECT event_id FROM usine_runs WHERE run_id = ?)",
              )
              .get(fixId);
          } finally {
            database.close();
          }
        }).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Struct({ task: Schema.String, ci_instructions: Schema.NullOr(Schema.String) }),
            ),
          ),
        );
        const current = withCiInstructions("", Option.some(policy)).ciInstructions;
        assert(Option.isSome(current));
        assert.strictEqual(row.ci_instructions, current.value);
        assert(row.task.endsWith(current.value));
        assert.include(row.task, "TypeError: failing CI log");
        assert.strictEqual((yield* engine.inspect(fixId)).task, row.task);
        yield* engine.drain;
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each(["an earlier wording", "no recorded instructions"] as const)(
  "a replayed CI fix recorded with %s ends with one current CI handoff",
  (recorded) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixtureInstance = yield* instance;
        const policy = CiPolicy.make({ fixLoop: loop.name, timeoutSeconds: 3600 });
        const configured = LoadedInstance.make({
          ...fixtureInstance,
          loops: [
            LoopFile.make({
              ...loop,
              maxCycles: CycleLimit.make(1),
              approval: "required",
              ci: Option.some(policy),
            }),
          ],
        });
        const setup = yield* scenario(3600, configured);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const reader = yield* RunReader;
          const budgets = yield* CycleBudgets;
          yield* openWait(setup.timeoutSeconds, true);
          yield* Ref.set(
            setup.observed,
            CheckSnapshot.make({ pullRequestState: "open", head, state: "failure" }),
          );
          yield* (yield* CiMonitor).reconcile(configured, Option.none());
          const ask = (yield* budgets.asks)[0] ?? assert.fail("missing cycle ask");
          const blocked = ask.blocks[0] ?? assert.fail("missing CI block");
          const earlier = "\n\nAn earlier wording of the CI handoff.";
          // Stands for an Event recorded by an earlier release: with other instructions, or
          // before the instructions were stored apart from the task.
          const withDatabase = <A>(use: (database: DatabaseSync) => A) =>
            Effect.sync(() => {
              const database = new DatabaseSync(join(setup.directory, ".usine/runtime.sqlite"));
              try {
                return use(database);
              } finally {
                database.close();
              }
            });
          const row = yield* withDatabase((database) =>
            database
              .prepare("SELECT task, ci_instructions FROM usine_trigger_events WHERE event_id = ?")
              .get(blocked.eventId),
          ).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({ task: Schema.String, ci_instructions: Schema.String }),
              ),
            ),
          );
          const stored = {
            prompt: row.task.slice(0, -row.ci_instructions.length),
            instructions: row.ci_instructions,
          };
          yield* withDatabase((database) =>
            recorded === "an earlier wording"
              ? database
                  .prepare(
                    "UPDATE usine_trigger_events SET task = ?, ci_instructions = ? WHERE event_id = ?",
                  )
                  .run(`${stored.prompt}${earlier}`, earlier, blocked.eventId)
              : database
                  .prepare(
                    "UPDATE usine_trigger_events SET ci_instructions = NULL WHERE event_id = ?",
                  )
                  .run(blocked.eventId),
          );
          yield* budgets.reset(
            ask.id,
            Event.make({
              id: EventId.make("reset-recorded-instructions"),
              dedupKey: DedupKey.make("reset-recorded-instructions"),
              receivedAt: yield* DateTime.now,
              payload: {},
            }),
          );
          yield* engine.reconcile;
          const fixId = yield* reader.runForEvent(DedupKey.make(blocked.eventId));
          assert(Option.isSome(fixId));
          const fix = yield* engine.inspect(fixId.value).pipe(
            Effect.repeat({
              until: ({ run }) => run.state._tag === "Waiting",
              schedule: Schedule.spaced("10 millis"),
            }),
            Effect.timeout("5 seconds"),
          );
          assert.include(stored.prompt, "TypeError: failing CI log");
          assert.strictEqual(fix.task, `${stored.prompt}${stored.instructions}`);
          assert.notInclude(fix.task, earlier);
          assert.strictEqual(fix.task.split("After pushing, end with").length, 2);
          yield* engine.drain;
        }).pipe(Effect.provide(setup.runtime));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("revokes a replayed CI fix when its loop's agent leaves the roster", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const recorded = LoadedInstance.make({
        ...fixtureInstance,
        loops: [LoopFile.make({ ...loop, maxCycles: CycleLimit.make(1) })],
      });
      const setup = yield* scenario(3600, recorded);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const reader = yield* RunReader;
        const budgets = yield* CycleBudgets;
        yield* openWait(setup.timeoutSeconds, true);
        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "open", head, state: "failure" }),
        );
        yield* (yield* CiMonitor).reconcile(recorded, Option.none());
        const ask = (yield* budgets.asks)[0] ?? assert.fail("missing cycle ask");
        const blocked = ask.blocks[0] ?? assert.fail("missing CI block");
        yield* Ref.set(
          setup.currentInstance,
          LoadedInstance.make({ ...recorded, agents: [], loops: [] }),
        );
        yield* budgets.reset(
          ask.id,
          Event.make({
            id: EventId.make("reset-missing-agent"),
            dedupKey: DedupKey.make("reset-missing-agent"),
            receivedAt: yield* DateTime.now,
            payload: {},
          }),
        );
        yield* engine.reconcile;
        const revoked = yield* reader.runForEvent(DedupKey.make(blocked.eventId));
        assert(Option.isNone(revoked));
        yield* Ref.set(setup.currentInstance, recorded);
        yield* engine.reconcile;
        const restored = yield* reader.runForEvent(DedupKey.make(blocked.eventId));
        assert(Option.isNone(restored));
        assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);
        yield* engine.drain;
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each(["newer head", "green checks"] as const)(
  "polling revokes an approval-waiting CI fix after %s",
  (change) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixtureInstance = yield* instance;
        const limited = LoadedInstance.make({
          ...fixtureInstance,
          loops: [LoopFile.make({ ...loop, maxCycles: CycleLimit.make(1), approval: "required" })],
        });
        const setup = yield* scenario(3600, limited);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const budgets = yield* CycleBudgets;
          const polling = yield* PollingTriggers;
          yield* openWait(setup.timeoutSeconds, true);
          yield* Ref.set(
            setup.observed,
            CheckSnapshot.make({ pullRequestState: "open", head, state: "failure" }),
          );
          yield* (yield* CiMonitor).reconcile(limited, Option.none());
          const ask = (yield* budgets.asks)[0] ?? assert.fail("missing cycle ask");
          const blocked = ask.blocks[0] ?? assert.fail("missing CI block");
          yield* budgets.reset(
            ask.id,
            Event.make({
              id: EventId.make("reset-waiting-ci-fix"),
              dedupKey: DedupKey.make("reset-waiting-ci-fix"),
              receivedAt: yield* DateTime.now,
              payload: {},
            }),
          );
          assert.deepStrictEqual((yield* polling.poll(limited)).failures, []);
          const reader = yield* RunReader;
          const fixId = yield* reader.runForEvent(DedupKey.make(blocked.eventId));
          assert(Option.isSome(fixId));
          const waiting = yield* engine.inspect(fixId.value).pipe(
            Effect.repeat({
              until: ({ run }) => run.state._tag === "Waiting",
              schedule: Schedule.spaced("10 millis"),
            }),
            Effect.timeout("5 seconds"),
          );
          assert.deepStrictEqual(waiting.attempts, []);

          yield* Ref.set(
            setup.observed,
            CheckSnapshot.make({
              pullRequestState: "open",
              head: change === "newer head" ? CommitSha.make("c".repeat(40)) : head,
              state: change === "green checks" ? "success" : "failure",
            }),
          );
          assert.deepStrictEqual((yield* polling.poll(limited)).failures, []);
          yield* engine.reconcile;
          const revoked = yield* engine.inspect(fixId.value);
          assert.strictEqual(revoked.run.state._tag, "Canceled");
          assert(revoked.run.state._tag === "Canceled");
          assert.strictEqual(revoked.run.state.reason._tag, "Revoked");
          assert.deepStrictEqual(revoked.attempts, []);
          assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);
        }).pipe(
          Effect.provide(
            PollingTriggers.layer.pipe(
              Layer.provideMerge(Layer.merge(setup.runtime, inertLabelReconcilerLayer)),
            ),
          ),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each([
  { state: "failure", outcome: "admitted" },
  { state: "failure", outcome: "admitted and pushed" },
  { state: "failure", outcome: "timed out" },
  { state: "conflict", outcome: "admitted" },
  { state: "conflict", outcome: "admitted through unknown mergeability" },
  { state: "conflict", outcome: "admitted and pushed" },
  { state: "conflict", outcome: "timed out" },
] as const)("a queued CI fix for $state waits for admission until $outcome", ({ state, outcome }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const fixturePayload = yield* payload;
      const completion = yield* Deferred.make<StepResult>();
      const setup = yield* scenario(
        outcome === "timed out" ? 1 : 3600,
        fixtureInstance,
        Deferred.await(completion),
      );
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const sourceId = yield* openWait(setup.timeoutSeconds);
        const expressions = yield* ExpressionEngine;

        const existing = yield* triggerSubmission(expressions, {
          loop,
          agent: agent.agent,
          parentModel: Option.none(),
          dedupKey: DedupKey.make("existing-fix"),
          cycleGeneration: CycleGeneration.make(0),
          itemKey: gitHubItemKey(repository, 815),
          payload: fixturePayload,
          receivedAt: yield* DateTime.now,
          repository: fixtureInstance.config.repos[0] ?? assert.fail("missing repo"),
          revision: RepositoryRevision.make(head),
          task: AttemptTask.make("Fix current findings"),
        });
        const active = yield* engine.submit(
          Submission.make({ ...existing, ciFailureHead: Option.some(head) }),
        );
        assert(active._tag === "Claimed");
        yield* Ref.get(setup.tasks).pipe(
          Effect.repeat({
            until: (all) => all.length === 2,
            schedule: Schedule.spaced("10 millis"),
          }),
          Effect.timeout("5 seconds"),
        );
        yield* Ref.set(
          setup.observed,
          CheckSnapshot.make({ pullRequestState: "open", head, state }),
        );
        const monitor = yield* CiMonitor;

        yield* monitor.reconcile(fixtureInstance, Option.none());

        assert.strictEqual((yield* engine.inspect(sourceId)).run.state._tag, "AwaitingCi");
        if (outcome === "timed out") {
          yield* Effect.sleep("1100 millis");

          yield* monitor.reconcile(fixtureInstance, Option.none());

          assert.strictEqual((yield* engine.inspect(sourceId)).run.state._tag, "Failed");
        }
        if (outcome === "admitted through unknown mergeability") {
          yield* Ref.set(setup.mergeable, "UNKNOWN");
        }
        yield* Deferred.succeed(completion, StepResult.make({ message: "Fixed", facts: [] }));
        yield* Ref.get(setup.tasks).pipe(
          Effect.repeat({
            until: (all) => all.length === 3,
            schedule: Schedule.spaced("10 millis"),
          }),
          Effect.timeout("5 seconds"),
        );
        yield* engine.drain;
        yield* Ref.set(setup.mergeable, "CONFLICTING");
        if (outcome === "admitted and pushed") {
          yield* Ref.set(
            setup.observed,
            CheckSnapshot.make({
              pullRequestState: "open",
              head: CommitSha.make("c".repeat(40)),
              state: "success",
            }),
          );
        }

        yield* monitor.reconcile(fixtureInstance, Option.none());
        const source = yield* engine.inspect(sourceId);
        if (outcome !== "timed out") {
          assert(source.run.state._tag === "HandedOff");
          assert.strictEqual(source.run.state.head, head);
          assert.strictEqual(
            source.attempts.at(-1)?.outcome.pipe(
              Option.map(({ _tag }) => _tag),
              Option.getOrNull,
            ),
            "HandedOff",
          );
          assert.notStrictEqual(source.run.state.fixRunId, active.runId);

          assert.strictEqual(
            (yield* engine.inspect(source.run.state.fixRunId)).run.loop,
            loop.name,
          );
        } else {
          assert.strictEqual(source.run.state._tag, "Failed");
        }

        assert.strictEqual((yield* Ref.get(setup.mutations)).length, 0);

        assert.strictEqual((yield* Ref.get(setup.tasks)).length, 3);
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
