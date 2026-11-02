import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { AgentFile } from "@usine/config/agent";
import { UsineConfig } from "@usine/config/factory";
import { LoadedInstance } from "@usine/config/instance";
import { LoopFile, PromptTemplate } from "@usine/config/loop";
import { ConfigParser } from "@usine/config/parser";
import { PullRequestTrigger } from "@usine/config/trigger";
import { AgentName, AgentPersona } from "@usine/core/agent";
import { ModelId } from "@usine/core/agent/brain";
import { AttemptTask } from "@usine/core/attempt";
import { runView } from "../src/operator/projection.ts";
import { runNeedsAttention } from "../src/board/items.ts";
import { RunSummary } from "@usine/engine/run-reader";
import { CiPolicy } from "@usine/core/ci";
import { CycleGeneration, CycleLimit } from "@usine/core/cycle-budget";
import { DedupKey } from "@usine/core/event";
import { InstanceDirectory } from "@usine/core/instance";
import { LoopName } from "@usine/core/loop";
import { CommitSha, RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { StepName } from "@usine/core/step";
import { PullRequest, StepResult } from "@usine/core/step/result";
import { WorkerName } from "@usine/core/worker";
import { CycleBudgets } from "@usine/engine/cycle-budget";
import { RunEngine, Submission } from "@usine/engine/engine";
import { layer as engineLayer } from "@usine/engine/local-sqlite";
import { StepExecutor } from "@usine/engine/step-executor";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { ExpressionEngine, Source } from "@usine/expression/expression-engine";
import { CheckFailureEvidence, CheckSnapshot, GitHubChecks } from "@usine/github/checks";
import { GitHubItemWriter, type ItemLabelMutation } from "@usine/github/item-writer";
import {
  ContentHash,
  GitHubPolling,
  PullRequestPayload,
  PullRequestSnapshot,
} from "@usine/github/polling";
import {
  DateTime,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Ref,
  Schedule,
  Schema,
} from "effect";
import { sqliteTempDirectory } from "../../../tooling/test/sqlite.mts";
import { triggerConditionLayer } from "../src/trigger-condition.ts";
import { fixedInstanceLayer } from "./support/current-instance.ts";
import { CiMonitor } from "../src/ci.ts";
import { triggerSubmission } from "../src/trigger-submission.ts";
import { gitHubItemKey } from "../src/polling/repository-sync.ts";
import { unmovedBaseRefHead } from "./support/polling.ts";

const repository = RepositoryName.make("basaltbytes/usine");
const head = CommitSha.make("a".repeat(40));
const agent = new AgentFile({
  name: AgentName.make("developer"),
  harness: "codex",
  model: ModelId.make("gpt-6.1-sol"),
  effort: "high",
  parentModel: Option.none(),
  parentEffort: Option.none(),
  persona: AgentPersona.make("Implement changes."),
});
const loop = new LoopFile({
  name: LoopName.make("fix"),
  maxCycles: CycleLimit.make(2),
  trigger: new PullRequestTrigger({ on: "pr", if: Source.make("false") }),
  selector: Option.none(),
  approval: "none",
  step: StepName.make("run"),
  agent: agent.name,
  body: PromptTemplate.make("Fix the failing checks."),
});
const instance = new LoadedInstance({
  config: Schema.decodeUnknownSync(UsineConfig)({ version: 1, repos: [{ name: repository }] }),
  agents: [agent],
  invalidAgents: [],
  loops: [loop],
  quarantinedLoops: [],
  warnings: [],
});
const payload = Schema.decodeUnknownSync(PullRequestPayload)({
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
  configured = instance,
  fixCompletion: Effect.Effect<StepResult> = Effect.succeed(
    new StepResult({ message: "Fixed", facts: [] }),
  ),
) {
  const fs = yield* FileSystem.FileSystem;
  const directory = InstanceDirectory.make(
    yield* fs.makeTempDirectoryScoped({ directory: sqliteTempDirectory(), prefix: "usine-ci-" }),
  );
  const observed = yield* Ref.make(new CheckSnapshot({ head, state: "pending" }));
  const tasks = yield* Ref.make<ReadonlyArray<string>>([]);
  const mutations = yield* Ref.make<
    ReadonlyArray<{ readonly item: number; readonly mutation: ItemLabelMutation }>
  >([]);
  const result = new StepResult({
    message: `[usine:awaiting-ci]\n${JSON.stringify({ pull_request: 815, head, fix_loop: "fix", timeout_seconds: timeoutSeconds, on_green: [{ item: 811, add: ["implemented"], remove: ["agent-in-progress"] }] })}`,
    facts: [new PullRequest({ number: 815, url: new URL(payload.url), head: Option.some(head) })],
  });
  const executor = Layer.succeed(StepExecutor)({
    workers: Effect.succeed([WorkerName.make("local")]),
    isLive: () => Effect.succeed(false),
    outcome: () => Effect.succeed(Option.none()),
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
      ),
  });
  const checks = Layer.succeed(GitHubChecks)({
    snapshot: () => Ref.get(observed),
    failures: () =>
      Effect.succeed(
        new CheckFailureEvidence({ jobs: ["ci"], excerpt: "TypeError: failing CI log" }),
      ),
  });
  const writer = Layer.succeed(GitHubItemWriter)({
    updateLabels: (_repository, item, mutation) =>
      Ref.update(mutations, (all) => [...all, { item, mutation }]).pipe(Effect.as([])),
  });
  const polling = Layer.succeed(GitHubPolling)({
    baseRefHead: unmovedBaseRefHead,
    changes: () => Effect.die("unused detection"),
    missingIssues: () => Effect.succeed([]),
    labels: () => Effect.die("unused labels"),
    snapshot: () =>
      Ref.get(observed).pipe(
        Effect.map(
          ({ head }) =>
            new PullRequestSnapshot({
              payload: PullRequestPayload.make({ ...payload, headRefOid: head }),
              contentHash: ContentHash.make("b".repeat(64)),
            }),
        ),
      ),
  });
  const engine = engineLayer(directory).pipe(
    Layer.provide(executor),
    Layer.provide(
      triggerConditionLayer.pipe(
        Layer.provide(polling),
        Layer.provide(MarcbachmannCelLayer),
        Layer.provide(fixedInstanceLayer(configured)),
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
  return { observed, tasks, mutations, runtime, timeoutSeconds };
});

const openWait = Effect.fn("test.openCiWait")(function* (timeoutSeconds: number, sameLoop = false) {
  const engine = yield* RunEngine;
  const submission = yield* triggerSubmission(yield* ExpressionEngine, {
    loop: new LoopFile({
      ...loop,
      name: sameLoop ? loop.name : LoopName.make("development"),
      ci: Option.some(new CiPolicy({ fixLoop: loop.name, timeoutSeconds })),
    }),
    agent: agent.agent,
    parentModel: Option.none(),
    dedupKey: DedupKey.make("ci-development"),
    cycleGeneration: CycleGeneration.make(0),
    itemKey: gitHubItemKey(repository, 815),
    payload,
    receivedAt: yield* DateTime.now,
    repository: instance.config.repos[0] ?? assert.fail("missing repo"),
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

it.live("green CI observed after the deadline applies the recorded labels once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const setup = yield* scenario(1);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const monitor = yield* CiMonitor;
        const runId = yield* openWait(setup.timeoutSeconds);
        yield* monitor.reconcile(instance, Option.none());
        assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);
        assert.strictEqual((yield* Ref.get(setup.mutations)).length, 0);
        yield* Ref.set(setup.observed, new CheckSnapshot({ head, state: "success" }));
        yield* Effect.sleep("1100 millis");
        yield* monitor.reconcile(instance, Option.none());
        yield* monitor.reconcile(instance, Option.none());
        assert.strictEqual((yield* engine.inspect(runId)).run.state._tag, "Succeeded");
        assert.strictEqual((yield* Ref.get(setup.mutations)).length, 1);
        assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("red CI observed after the deadline starts one budgeted fix with failure diagnostics", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const setup = yield* scenario(1);
      yield* Effect.gen(function* () {
        const monitor = yield* CiMonitor;
        const engine = yield* RunEngine;
        const runId = yield* openWait(setup.timeoutSeconds);
        yield* Ref.set(setup.observed, new CheckSnapshot({ head, state: "failure" }));
        yield* Effect.sleep("1100 millis");
        yield* monitor.reconcile(instance, Option.none());
        yield* monitor.reconcile(instance, Option.none());
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
        const projected = runView(new RunSummary(settled), new Set(), new Map());
        assert.strictEqual(runNeedsAttention(projected, false), false);
        assert.strictEqual((yield* Ref.get(setup.mutations)).length, 0);
        yield* engine.drain();
        const another = yield* triggerSubmission(yield* ExpressionEngine, {
          loop: new LoopFile({ ...loop, maxCycles: CycleLimit.make(1) }),
          agent: agent.agent,
          parentModel: Option.none(),
          dedupKey: DedupKey.make("another-fix"),
          cycleGeneration: CycleGeneration.make(0),
          itemKey: gitHubItemKey(repository, 815),
          payload,
          receivedAt: yield* DateTime.now,
          repository: instance.config.repos[0] ?? assert.fail("missing repo"),
          revision: RepositoryRevision.make(head),
          task: AttemptTask.make("Fix again"),
        });
        assert.strictEqual((yield* engine.submit(another))._tag, "CycleBlocked");
        assert.strictEqual((yield* (yield* CycleBudgets).asks()).length, 1);
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "issue and PR completion actions survive successive CI fixes until the final head passes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const heads = [CommitSha.make("b".repeat(40)), CommitSha.make("c".repeat(40))];
        const completedFixes = yield* Ref.make(0);
        const setup = yield* scenario(
          3600,
          instance,
          Ref.updateAndGet(completedFixes, (count) => count + 1).pipe(
            Effect.map((count) => {
              const fixedHead = heads[count - 1] ?? assert.fail("unexpected fix attempt");
              return new StepResult({
                message: `[usine:awaiting-ci]\n${JSON.stringify({ pull_request: 815, head: fixedHead, fix_loop: "fix", timeout_seconds: 3600, on_green: [{ item: 815, add: [count === 1 ? "fix-validated" : "ready-for-review"], remove: ["agent-review-findings"] }] })}`,
                facts: [
                  new PullRequest({
                    number: 815,
                    url: new URL(payload.url),
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
              new CheckSnapshot({ head: failedHead, state: "failure" }),
            );
            yield* monitor.reconcile(instance, Option.none());
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
          yield* Ref.set(setup.observed, new CheckSnapshot({ head: failedHead, state: "success" }));
          yield* monitor.reconcile(instance, Option.none());
          yield* monitor.reconcile(instance, Option.none());
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
      const setup = yield* scenario(1);
      yield* Effect.gen(function* () {
        const runId = yield* openWait(setup.timeoutSeconds);
        yield* Ref.set(
          setup.observed,
          new CheckSnapshot({ head: CommitSha.make("c".repeat(40)), state: "success" }),
        );
        yield* Effect.sleep("1100 millis");
        yield* (yield* CiMonitor).reconcile(instance, Option.none());
        assert.strictEqual((yield* (yield* RunEngine).inspect(runId)).run.state._tag, "Canceled");
        assert.strictEqual((yield* Ref.get(setup.mutations)).length, 0);
        assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a silent check times out as a failed run for Needs attention", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const setup = yield* scenario(1);
      yield* Effect.gen(function* () {
        const runId = yield* openWait(setup.timeoutSeconds);
        yield* Effect.sleep("1100 millis");
        yield* (yield* CiMonitor).reconcile(instance, Option.none());
        const failed = yield* (yield* RunEngine).inspect(runId);
        assert.strictEqual(failed.run.state._tag, "Failed");
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

it.live("CI fixes from their own loop are admitted before the source hands off", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const setup = yield* scenario(3600);
      yield* Effect.gen(function* () {
        const sourceId = yield* openWait(setup.timeoutSeconds, true);
        yield* Ref.set(setup.observed, new CheckSnapshot({ head, state: "failure" }));
        yield* (yield* CiMonitor).reconcile(instance, Option.none());
        yield* Ref.get(setup.tasks).pipe(
          Effect.repeat({
            until: (all) => all.length === 2,
            schedule: Schedule.spaced("10 millis"),
          }),
          Effect.timeout("5 seconds"),
        );
        yield* (yield* RunEngine).drain();
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
      const limited = new LoadedInstance({
        ...instance,
        loops: [new LoopFile({ ...loop, maxCycles: CycleLimit.make(1) })],
      });
      const setup = yield* scenario(3600, limited);
      yield* Effect.gen(function* () {
        const runId = yield* openWait(setup.timeoutSeconds, true);
        yield* Ref.set(setup.observed, new CheckSnapshot({ head, state: "failure" }));
        yield* (yield* CiMonitor).reconcile(limited, Option.none());
        const source = yield* (yield* RunEngine).inspect(runId);
        assert.strictEqual(source.run.state._tag, "Failed");
        const projected = runView(new RunSummary(source), new Set(), new Map());
        assert.strictEqual(runNeedsAttention(projected, false), true);
        assert.strictEqual((yield* (yield* CycleBudgets).asks()).length, 1);
        assert.strictEqual((yield* Ref.get(setup.tasks)).length, 1);
      }).pipe(Effect.provide(setup.runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each(["admitted", "timed out"] as const)(
  "a queued CI fix waits for admission until %s",
  (outcome) =>
    Effect.scoped(
      Effect.gen(function* () {
        const completion = yield* Deferred.make<StepResult>();
        const setup = yield* scenario(
          outcome === "admitted" ? 3600 : 1,
          instance,
          Deferred.await(completion),
        );
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const sourceId = yield* openWait(setup.timeoutSeconds);
          const existing = yield* triggerSubmission(yield* ExpressionEngine, {
            loop,
            agent: agent.agent,
            parentModel: Option.none(),
            dedupKey: DedupKey.make("existing-fix"),
            cycleGeneration: CycleGeneration.make(0),
            itemKey: gitHubItemKey(repository, 815),
            payload,
            receivedAt: yield* DateTime.now,
            repository: instance.config.repos[0] ?? assert.fail("missing repo"),
            revision: RepositoryRevision.make(head),
            task: AttemptTask.make("Fix current findings"),
          });
          const active = yield* engine.submit(
            new Submission({ ...existing, ciFailureHead: Option.some(head) }),
          );
          assert(active._tag === "Claimed");
          yield* Ref.get(setup.tasks).pipe(
            Effect.repeat({
              until: (all) => all.length === 2,
              schedule: Schedule.spaced("10 millis"),
            }),
            Effect.timeout("5 seconds"),
          );
          yield* Ref.set(setup.observed, new CheckSnapshot({ head, state: "failure" }));
          const monitor = yield* CiMonitor;
          yield* monitor.reconcile(instance, Option.none());
          assert.strictEqual((yield* engine.inspect(sourceId)).run.state._tag, "AwaitingCi");
          if (outcome === "timed out") {
            yield* Effect.sleep("1100 millis");
            yield* monitor.reconcile(instance, Option.none());
            assert.strictEqual((yield* engine.inspect(sourceId)).run.state._tag, "Failed");
          }
          yield* Deferred.succeed(completion, new StepResult({ message: "Fixed", facts: [] }));
          yield* engine.drain();
          yield* monitor.reconcile(instance, Option.none());
          const source = yield* engine.inspect(sourceId);
          if (outcome === "admitted") {
            assert(source.run.state._tag === "HandedOff");
            assert.notStrictEqual(source.run.state.fixRunId, active.runId);
            assert.strictEqual(
              (yield* engine.inspect(source.run.state.fixRunId)).run.loop,
              loop.name,
            );
          } else {
            assert.strictEqual(source.run.state._tag, "Failed");
          }
          assert.strictEqual((yield* Ref.get(setup.tasks)).length, 3);
        }).pipe(Effect.provide(setup.runtime));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
