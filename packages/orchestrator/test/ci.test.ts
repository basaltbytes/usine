import { jsonKey } from "@usine/core/json-key";
import { assert, it } from "@effect/vitest";
// The retention assertion must run after Node’s check phase releases native async handles.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { setImmediate } from "node:timers/promises";
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
import { ApprovalSource } from "@usine/core/run/approval";
import { StepName } from "@usine/core/step";
import { PullRequest, StepCompletion, StepResult } from "@usine/core/step/result";
import { WorkerName } from "@usine/core/worker";
import { CycleBudgets } from "@usine/engine/cycle-budget";
import { RunReader } from "@usine/engine/run-reader";
import { LoopControl } from "@usine/engine/loop-control";
import { RunEngine, Submission } from "@usine/engine/engine";
import { layer as engineLayer } from "@usine/engine/local-sqlite";
import { StepExecutor } from "@usine/engine/step-executor";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { ExpressionEngine, Source } from "@usine/expression/expression-engine";
import {
  CheckFailureEvidence,
  CheckSnapshot,
  GitHubChecks,
  PendingCheck,
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
import { triggerSubmission } from "../src/trigger-submission.ts";
import { gitHubItemKey } from "../src/polling/repository-sync.ts";
import { inertLabelReconcilerLayer, unmovedBaseRefHead } from "./support/polling.ts";

const repository = RepositoryName.make("basaltbytes/usine");
const head = CommitSha.make("a".repeat(40));
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
  const observed = yield* Ref.make(CheckSnapshot.make({ head, state: "pending" }));
  const itemState = yield* Ref.make<"OPEN" | "CLOSED" | "MERGED" | "gone">("OPEN");
  const observationFailure = yield* Ref.make(Option.none<GitHubApiError | GitHubRateLimitError>());
  const mergeable = yield* Ref.make<PullRequestPayload["mergeable"]>("CONFLICTING");
  const tasks = yield* Ref.make<ReadonlyArray<string>>([]);
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
    recover: () => Effect.void,
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
  const checks = Layer.succeed(GitHubChecks)({
    pendingDetails: () =>
      Effect.gen(function* () {
        yield* Deferred.succeed(pendingStarted, undefined);
        if (yield* Ref.get(pendingStalled)) return yield* Effect.never;
        const failure = yield* Ref.get(pendingFailure);
        if (Option.isSome(failure)) return yield* failure.value;
        return [
          PendingCheck.make({
            name: "test (web)",
            status: "in_progress",
            startedAt: Option.some(DateTime.makeUnsafe("2026-11-05T19:54:00Z")),
            elapsedMilliseconds: Option.some(31 * 60000),
            previousDurationMilliseconds: Option.some(6 * 60000),
          }),
          PendingCheck.make({
            name: "test (server)",
            status: "queued",
            startedAt: Option.none(),
            elapsedMilliseconds: Option.none(),
            previousDurationMilliseconds: Option.none(),
          }),
        ];
      }),
    snapshot: () =>
      Effect.gen(function* () {
        const failure = yield* Ref.get(observationFailure);
        if (Option.isSome(failure)) return yield* failure.value;
        return yield* Ref.get(observed);
      }),
    failures: () =>
      Ref.get(observed).pipe(
        Effect.flatMap(({ state }) =>
          state === "conflict"
            ? Effect.die("A merge conflict has no failed check logs")
            : Effect.succeed(
                CheckFailureEvidence.make({ jobs: ["ci"], excerpt: "TypeError: failing CI log" }),
              ),
        ),
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
    currentInstance,
    observed,
    itemState,
    observationFailure,
    pendingFailure,
    pendingStarted,
    pendingStalled,
    mergeable,
    tasks,
    mutations,
    runtime,
    timeoutSeconds,
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
        yield* Ref.set(setup.observed, CheckSnapshot.make({ head, state: "success" }));

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
        yield* Ref.set(setup.observed, CheckSnapshot.make({ head, state: "success" }));
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

it.live("a conflicting head without checks starts one fix before the CI deadline", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const setup = yield* scenario(3600);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const monitor = yield* CiMonitor;
        const sourceId = yield* openWait(setup.timeoutSeconds);
        yield* Ref.set(setup.observed, CheckSnapshot.make({ head, state: "conflict" }));

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
        yield* Ref.set(setup.observed, CheckSnapshot.make({ head, state: "failure" }));
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
            CheckSnapshot.make({ head: failedHead, state: "success" }),
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
          CheckSnapshot.make({ head: CommitSha.make("c".repeat(40)), state: "success" }),
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
          if (diagnostics === "available") {
            assert.include(outcome.failure.message, "test (web) is in_progress");
            assert.include(outcome.failure.message, "test (server) is queued");
            assert.include(outcome.failure.message, "31 min");
            assert.include(outcome.failure.message, "6 min");
          } else {
            assert.include(outcome.failure.message, "Pending job diagnostics are unavailable.");
          }
          const mutations = yield* Ref.get(setup.mutations);
          assert.deepStrictEqual(mutations, []);
          assert.strictEqual(
            failed.attempts
              .at(-1)
              ?.outcome.pipe(Option.map(({ _tag }) => _tag))
              .pipe(Option.getOrNull),
            "Failed",
          );

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
      yield* TestClock.setTime(DateTime.toEpochMillis(endedAt.value) + 1001);
      yield* Ref.set(setup.pendingStalled, true);
      const reconcile = yield* (yield* CiMonitor)
        .reconcile(fixtureInstance, Option.none())
        .pipe(Effect.forkChild);
      yield* Deferred.await(setup.pendingStarted);
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

it.live("CI fixes from their own loop are admitted before the source hands off", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const setup = yield* scenario(3600);
      yield* Effect.gen(function* () {
        const sourceId = yield* openWait(setup.timeoutSeconds, true);
        yield* Ref.set(setup.observed, CheckSnapshot.make({ head, state: "failure" }));

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
        yield* Ref.set(setup.observed, CheckSnapshot.make({ head, state: "failure" }));

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

it.live.each(["failure", "superseded", "success", "paused", "CLOSED", "MERGED", "gone"] as const)(
  "a cycle reset rechecks a blocked CI fix without a trigger label: %s",
  (state) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixtureInstance = yield* instance;
        const terminal = state === "CLOSED" || state === "MERGED" || state === "gone";
        const limited = LoadedInstance.make({
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
              approval: terminal || state === "failure" ? "required" : "none",
            }),
          ],
        });
        const setup = yield* scenario(3600, limited);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const budgets = yield* CycleBudgets;
          const monitor = yield* CiMonitor;
          yield* openWait(setup.timeoutSeconds, true);
          yield* Ref.set(setup.observed, CheckSnapshot.make({ head, state: "failure" }));
          yield* monitor.reconcile(limited, Option.none());
          const ask = (yield* budgets.asks)[0] ?? assert.fail("missing cycle ask");
          const blocked = ask.blocks[0] ?? assert.fail("missing CI block");
          const answer = Event.make({
            id: EventId.make("reset-ci-fix"),
            dedupKey: DedupKey.make("reset-ci-fix"),
            receivedAt: yield* DateTime.now,
            payload: {},
          });
          const polling = yield* PollingTriggers;
          assert.deepStrictEqual((yield* polling.poll(limited)).failures, []);
          yield* budgets.reset(ask.id, answer);
          const reader = yield* RunReader;
          if (terminal) {
            yield* engine.reconcile;
            const fixId = yield* reader.runForEvent(DedupKey.make(blocked.eventId));
            assert(Option.isSome(fixId));
            yield* engine.inspect(fixId.value).pipe(
              Effect.repeat({
                until: ({ run }) => run.state._tag === "Waiting",
                schedule: Schedule.spaced("10 millis"),
              }),
              Effect.timeout("5 seconds"),
            );
            yield* Ref.set(setup.itemState, state);
          }
          const controls = yield* LoopControl;
          if (state === "paused") yield* controls.pause(loop.name);
          if (state === "superseded" || state === "success") {
            yield* Ref.set(
              setup.observed,
              CheckSnapshot.make({
                head: state === "superseded" ? CommitSha.make("c".repeat(40)) : head,
                state: "success",
              }),
            );
          }

          const cycle = yield* polling.poll(limited);
          assert.deepStrictEqual(cycle.failures, []);
          if (state === "failure") {
            const fixId = yield* reader.runForEvent(DedupKey.make(blocked.eventId));
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
          }
          if (state === "paused") {
            assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);
            const resets = yield* budgets.pendingResets;
            for (const reset of resets) yield* budgets.acknowledgeReset(reset);
            yield* controls.unpause(loop.name);
            yield* engine.reconcile;
          }
          if (state === "failure" || state === "paused") {
            yield* Ref.get(setup.tasks).pipe(
              Effect.repeat({
                until: (tasks) => tasks.length === 2,
                schedule: Schedule.spaced("10 millis"),
              }),
              Effect.timeout("5 seconds"),
            );
          }
          yield* engine.drain;
          yield* budgets.reset(ask.id, answer);
          yield* monitor.reconcile(limited, Option.none());

          assert.strictEqual(
            (yield* Ref.get(setup.tasks)).length,
            state === "failure" || state === "paused" ? 2 : 1,
          );
          const remainingAsks = yield* budgets.asks;
          assert.deepStrictEqual(remainingAsks, []);
          const fixId = yield* reader.runForEvent(DedupKey.make(blocked.eventId));
          if (state === "failure" || state === "paused") {
            assert(Option.isSome(fixId));
            const fix = yield* engine.inspect(fixId.value);
            assert.strictEqual(fix.event.id, blocked.eventId);
            const tasks = yield* Ref.get(setup.tasks);
            assert.include(tasks[1] ?? "", "TypeError: failing CI log");
          } else if (terminal) {
            assert(Option.isSome(fixId));
            const revoked = yield* engine.inspect(fixId.value);
            assert(revoked.run.state._tag === "Canceled");
            assert.strictEqual(revoked.run.state.reason._tag, "Revoked");
            assert.deepStrictEqual(revoked.attempts, []);
          } else {
            assert(Option.isNone(fixId));
          }
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
  { recorded: "none", current: "required" },
  { recorded: "required", current: "none" },
] as const)(
  "a replayed CI fix recorded with approval $recorded takes approval $current from the current loop",
  ({ recorded, current }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixtureInstance = yield* instance;
        const configured = (approval: "none" | "required") =>
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
          yield* Ref.set(setup.observed, CheckSnapshot.make({ head, state: "failure" }));
          yield* (yield* CiMonitor).reconcile(configured(recorded), Option.none());
          const source = yield* engine.inspect(sourceId);
          assert.strictEqual(source.run.state._tag, "Failed");
          const ask = (yield* budgets.asks)[0] ?? assert.fail("missing cycle ask");
          const blocked = ask.blocks[0] ?? assert.fail("missing CI block");
          const unlinked = yield* reader.ciFixRuns([sourceId]);
          assert.strictEqual(unlinked.size, 0);
          const edited = configured(current);
          yield* Ref.set(setup.currentInstance, edited);

          const replayed = yield* budgets.reset(
            ask.id,
            Event.make({
              id: EventId.make("reset-edited-ci-fix"),
              dedupKey: DedupKey.make("reset-edited-ci-fix"),
              receivedAt: yield* DateTime.now,
              payload: {},
            }),
          );
          const cycle = yield* (yield* PollingTriggers).poll(edited);

          assert.deepStrictEqual(replayed, [blocked.eventId]);
          assert.deepStrictEqual(cycle.failures, []);
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
          if (current === "required") {
            assert.strictEqual(fix.run.state._tag, "Waiting");
            assert.deepStrictEqual(fix.attempts, []);
            assert.include(reason, "the loop requires approval");
          } else {
            assert.strictEqual(fix.run.state._tag, "Succeeded");
            assert(Option.isNone(fix.approval));
            assert.include(reason, "the loop allows automatic starts");
            const tasks = yield* Ref.get(setup.tasks);
            assert.include(tasks[1] ?? "", "TypeError: failing CI log");
          }
          const linked = yield* reader.ciFixRuns([sourceId]);
          assert.strictEqual(linked.get(sourceId), fixId.value);
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
          yield* Ref.set(setup.observed, CheckSnapshot.make({ head, state: "failure" }));
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
        yield* Ref.set(setup.observed, CheckSnapshot.make({ head, state }));
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
            CheckSnapshot.make({ head: CommitSha.make("c".repeat(40)), state: "success" }),
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
