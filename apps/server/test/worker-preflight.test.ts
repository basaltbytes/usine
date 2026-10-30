import { sqliteTempDirectory } from "../../../tooling/test/sqlite.mts";
import { ConfigurationStore } from "@usine/config/configuration";
import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { UsineConfig } from "@usine/config/factory";
import { LoadedInstance } from "@usine/config/instance";
import { Agent, AgentName, AgentPersona } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AttemptTask } from "@usine/core/attempt";
import { DedupKey, Event, EventId } from "@usine/core/event";
import { InstanceDirectory } from "@usine/core/instance";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { StepName } from "@usine/core/step";
import { BotAccount, BotLogin, BotUserId, WorkerName } from "@usine/core/worker";
import { RunEngine, Submission } from "@usine/engine/engine";
import { layer as engineLayer } from "@usine/engine/local-sqlite";
import { StepExecutor } from "@usine/engine/step-executor";
import { TriggerCondition } from "@usine/engine/trigger-condition";
import { Executor, ExecutorOperationError, fullPreflight } from "@usine/executor";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { GitHubApp } from "@usine/github/github-app";
import { CurrentInstance } from "@usine/orchestrator/current-instance";
import { idleTriggersLayer } from "@usine/orchestrator/idle-triggers";
import {
  DeskView,
  FactoryOverview,
  Operator,
  OperatorConfiguration,
  OperatorObservation,
} from "@usine/orchestrator/operator";
import { stepExecutorLayer } from "@usine/orchestrator/scheduler";
import {
  DateTime,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Schema,
  Stream,
} from "effect";
import { HttpClient, HttpRouter } from "effect/http";
import { TestClock } from "effect/testing";
import { assert, it } from "vitest";
import { liveBackendLayer } from "../src/backend.ts";
import { apiRoutes } from "../src/http.ts";

const failedWorker = WorkerName.make("failed");
const healthyWorker = WorkerName.make("healthy");
const instance = new LoadedInstance({
  config: Schema.decodeUnknownSync(UsineConfig)({
    version: 1,
    repos: [],
    workers: [
      { name: failedWorker, kind: "local" },
      { name: healthyWorker, kind: "local" },
    ],
  }),
  agents: [],
  loops: [],
  invalidAgents: [],
  quarantinedLoops: [],
  warnings: [],
});
const submission = new Submission({
  event: new Event({
    id: EventId.make("preflight-event"),
    dedupKey: DedupKey.make("preflight-event"),
    payload: {},
    receivedAt: DateTime.makeUnsafe("2026-10-28T00:00:00Z"),
  }),
  itemKey: ItemKey.make("basaltbytes/usine#657"),
  loop: LoopName.make("implement"),
  step: StepName.make("implement"),
  approval: "none",
  repository: RepositoryName.make("basaltbytes/usine"),
  revision: RepositoryRevision.make("main"),
  task: AttemptTask.make("Implement the issue"),
  agent: new Agent({
    name: AgentName.make("developer"),
    brain: new BrainSpec({ harness: "codex", model: ModelId.make("gpt-6-sol"), effort: "high" }),
    parentModel: Option.none(),
    parentEffort: Option.none(),
    persona: AgentPersona.make("Implement the issue"),
  }),
  parentModel: Option.none(),
});

it("serves the API and runs on a healthy worker, then restores a failed worker and clears attention without restarting", async () => {
  const program = Effect.gen(function* () {
    const directory = InstanceDirectory.make(
      yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        directory: sqliteTempDirectory(),
        prefix: "usine-preflight-api-",
      }),
    );
    const executing = yield* Deferred.make<WorkerName>();
    let failedChecks = 0;
    const executor = Layer.mock(Executor)({
      kind: "local",
      preflight: (worker, brains) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(brains, [submission.agent.brain]);
          if (worker === failedWorker && ++failedChecks === 1)
            return yield* new ExecutorOperationError({
              operation: "preflight",
              message: "Scripted probe unavailable",
              cause: "offline",
            });
          return fullPreflight;
        }),
      prepare: (request) =>
        Deferred.succeed(executing, request.worker).pipe(Effect.andThen(Effect.never)),
      sweep: Effect.void,
    });
    const current = Layer.succeed(CurrentInstance)({
      get: Effect.succeed(instance),
      changes: Stream.make(instance),
      reload: Effect.die("unused"),
      commit: () => Effect.die("unused"),
      registerWorkers: () => Effect.void,
    });
    const app = Layer.mock(GitHubApp)({
      botAccount: () =>
        Effect.succeed(
          new BotAccount({
            login: BotLogin.make("usine-test[bot]"),
            id: BotUserId.make(4242),
          }),
        ),
    });
    const scheduler = stepExecutorLayer(instance.config, [submission.agent.brain]).pipe(
      Layer.provide(Layer.mergeAll(executor, current, app)),
    );
    const engine = engineLayer(directory).pipe(
      Layer.provideMerge(scheduler),
      Layer.provide(Layer.succeed(TriggerCondition)({ recheck: () => Effect.succeed("matches") })),
    );
    const observation = OperatorObservation.layer.pipe(
      Layer.provide(Layer.mock(ConfigurationStore)({})),
      Layer.provide(Layer.merge(idleTriggersLayer, MarcbachmannCelLayer)),
      Layer.provideMerge(engine),
    );
    yield* Effect.gen(function* () {
      const reads = yield* OperatorObservation;
      const runs = yield* RunEngine;
      const steps = yield* StepExecutor;
      const operator = yield* Operator.pipe(
        Effect.provide(Layer.mock(Operator)({ overview: reads.overview, desk: reads.desk })),
      );
      const configuration = yield* OperatorConfiguration.pipe(
        Effect.provide(Layer.mock(OperatorConfiguration)({})),
      );
      const backend = liveBackendLayer({ get: Effect.succeed(instance) }, operator, configuration);
      const server = HttpRouter.serve(
        apiRoutes(Option.none()).pipe(HttpRouter.provideRequest(backend)),
        { disableLogger: true },
      ).pipe(Layer.provideMerge(NodeHttpServer.layerTest));
      yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const overview = client.get("/api/overview").pipe(
          Effect.tap((response) => Effect.sync(() => assert.strictEqual(response.status, 200))),
          Effect.flatMap((response) => response.text),
          Effect.map(Schema.decodeUnknownSync(Schema.fromJsonString(FactoryOverview))),
        );
        const before = yield* overview;
        assert.deepStrictEqual(
          before.needsYou.map((need) => need._tag),
          ["WorkerPreflightNeed"],
        );
        const need = before.needsYou[0];
        assert(need?._tag === "WorkerPreflightNeed");
        assert.strictEqual(need.worker, failedWorker);
        assert.include(need.message, "Scripted probe unavailable");
        yield* runs.submit(submission);
        assert.strictEqual(yield* Deferred.await(executing), healthyWorker);
        const waiting = yield* steps
          .reserve(RunId.make("waiting-for-failed"), submission, Option.some(failedWorker))
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("59 seconds");
        assert.isUndefined(waiting.pollUnsafe());
        yield* TestClock.adjust("1 second");
        const lease = yield* Fiber.join(waiting);
        assert.strictEqual(lease.worker, failedWorker);
        assert.strictEqual(failedChecks, 2);
        assert.deepStrictEqual((yield* overview).needsYou, []);
        const desk = yield* client.get("/api/desk").pipe(
          Effect.flatMap((response) => response.text),
          Effect.map(Schema.decodeUnknownSync(Schema.fromJsonString(DeskView))),
        );
        assert.strictEqual(
          desk.workers.find(({ name }) => name === failedWorker)?.preflight?._tag,
          "Passed",
        );
        yield* lease.release;
      }).pipe(Effect.provide(server));
    }).pipe(Effect.provide(observation));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.provide(TestClock.layer()));
  await Effect.runPromise(program);
}, 30_000);
