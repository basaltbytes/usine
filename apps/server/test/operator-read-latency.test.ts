import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { AgentFile } from "@usine/config/agent";
import { UsineConfig } from "@usine/config/factory";
import { LoadedInstance } from "@usine/config/instance";
import { LoopFile, PromptTemplate } from "@usine/config/loop";
import { IssueTrigger } from "@usine/config/trigger";
import { Agent, AgentName, AgentPersona } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AttemptTask } from "@usine/core/attempt";
import { DedupKey, Event, EventId } from "@usine/core/event";
import { InstanceDirectory } from "@usine/core/instance";
import { ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { StepName } from "@usine/core/step";
import { WorkerName } from "@usine/core/worker";
import { RunEngine, Submission } from "@usine/engine/engine";
import {
  ItemContentHash,
  ItemProjection,
  ItemProjectionSource,
  ItemProjectionWriter,
} from "@usine/engine/item-projection";
import { layer as engineLayer } from "@usine/engine/local-sqlite";
import { StepExecutor } from "@usine/engine/step-executor";
import { TriggerCondition } from "@usine/engine/trigger-condition";
import { Source } from "@usine/expression/expression-engine";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { idleTriggersLayer } from "@usine/orchestrator/idle-triggers";
import {
  DeskView,
  FactoryOverview,
  Operator,
  OperatorConfiguration,
  OperatorObservation,
} from "@usine/orchestrator/operator";
import { GitHubItemKey } from "@usine/orchestrator/polling-triggers";
import { WorkerStatus } from "@usine/orchestrator/worker-status";
import { Clock, DateTime, Deferred, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { HttpClient, HttpRouter } from "effect/unstable/http";
import { assert, describe, it } from "vitest";
import { liveBackendLayer } from "../src/backend.ts";
import { apiRoutes } from "../src/http.ts";

// The dogfood instance has five Loops and about 500 Items on its Board; the overview and the desk
// each evaluate every Loop's trigger on every Item, and the web UI polls both at once.
const BOARD_ITEMS = 500;
const LABELS = [
  "ready-for-agent",
  "agent-in-progress",
  "ready-for-review",
  "agent-review-findings",
  "review-passed",
];
// Maximum read latency while an Attempt starts (#464).
const READ_BUDGET_MILLIS = 500;
const READS = 3;

const repository = RepositoryName.make("basaltbytes/usine");
const itemKey = (number: number) =>
  Schema.encodeSync(GitHubItemKey)(["github", repository, ItemNumber.make(number)]);
const brain = new BrainSpec({
  harness: "codex",
  model: ModelId.make("gpt-6-astra"),
  effort: "medium",
});
const developer = new AgentFile({
  name: AgentName.make("developer"),
  harness: brain.harness,
  model: brain.model,
  effort: brain.effort,
  parentModel: Option.none(),
  parentEffort: Option.none(),
  persona: AgentPersona.make("Implement the issue."),
});
const firstLoop = LoopName.make("loop-0");
const loops = LABELS.map(
  (label, index) =>
    new LoopFile({
      name: LoopName.make(`loop-${index}`),
      trigger: new IssueTrigger({
        on: "issue",
        if: Source.make(
          `item.state == "OPEN" && item.labels.nodes.exists(label, label.name == "${label}") && !item.labels.nodes.exists(label, label.name == "blocked")`,
        ),
      }),
      selector: Option.none(),
      approval: "none",
      step: StepName.make("run"),
      agent: developer.name,
      body: PromptTemplate.make("Work on it."),
    }),
);
const instance = new LoadedInstance({
  config: Schema.decodeUnknownSync(UsineConfig)({
    version: 1,
    repos: [{ name: repository }],
    workers: [{ name: "worker", kind: "local", max_concurrent_attempts: 2 }],
  }),
  agents: [developer],
  invalidAgents: [],
  loops,
  quarantinedLoops: [],
  warnings: [],
});

// One Item in ten has a Loop's label, as on a Board where most work is done.
const labelOf = (number: number) =>
  number % 10 === 0 ? (LABELS[(number / 10) % LABELS.length] ?? "bug") : "bug";

const issue = (number: number) =>
  new ItemProjection({
    itemKey: itemKey(number),
    repository,
    source: ItemProjectionSource.make("issue"),
    number: ItemNumber.make(number),
    contentHash: ItemContentHash.make(`issue-${number}`),
    payload: {
      number,
      title: `Issue ${number}`,
      body: "What to build and how to tell it is done. ".repeat(20),
      url: `https://github.com/basaltbytes/usine/issues/${number}`,
      state: "OPEN",
      stateReason: null,
      createdAt: "2026-10-19T10:00:00Z",
      updatedAt: "2026-10-19T12:00:00Z",
      closedAt: null,
      author: { login: "PhilDL" },
      issueType: null,
      milestone: null,
      labels: { totalCount: 1, nodes: [{ name: labelOf(number) }] },
      assignees: { totalCount: 0, nodes: [] },
      comments: {
        totalCount: 2,
        nodes: [1, 2].map((comment) => ({
          author: { login: "usine-agent[bot]" },
          body: "Progress on the issue. ".repeat(10),
          createdAt: "2026-10-19T11:00:00Z",
          url: `https://github.com/basaltbytes/usine/issues/${number}#issuecomment-${comment}`,
        })),
      },
      closedByPullRequestsReferences: { totalCount: 0, nodes: [] },
    },
    goneAt: Option.none(),
  });

const started = (number: number) =>
  new Submission({
    event: new Event({
      id: EventId.make(`event-${number}`),
      dedupKey: DedupKey.make(`${firstLoop}/${number}`),
      payload: { number },
      receivedAt: DateTime.makeUnsafe("2026-10-21T16:48:00Z"),
    }),
    itemKey: itemKey(number),
    loop: firstLoop,
    step: StepName.make("run"),
    approval: "none",
    repository,
    revision: RepositoryRevision.make("main"),
    task: AttemptTask.make(`Implement issue ${number}.`),
    agent: new Agent({
      name: developer.name,
      brain,
      parentModel: Option.none(),
      parentEffort: Option.none(),
      persona: developer.persona,
    }),
    parentModel: Option.none(),
  });

/** Runs `effect` and returns its value with the elapsed real-clock milliseconds. */
const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const before = yield* Clock.currentTimeMillis;
    const value = yield* effect;
    return { millis: (yield* Clock.currentTimeMillis) - before, value } as const;
  });

const decodeOverview = Schema.decodeUnknownSync(Schema.fromJsonString(FactoryOverview));
const decodeDesk = Schema.decodeUnknownSync(Schema.fromJsonString(DeskView));

describe("operator read latency", () => {
  it(`answers /api/overview and /api/desk, requested together, in under ${READ_BUDGET_MILLIS} ms while an Attempt starts on a Board of ${BOARD_ITEMS} Items and five Loops`, async () => {
    const program = Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-read-latency-" });
      const preparing = yield* Deferred.make<void>();
      // A Worker whose preparation, such as an SSH preflight, lasts until the test ends.
      const slowWorker = Layer.succeed(StepExecutor)({
        workers: Effect.succeed([WorkerName.make("worker")]),
        isLive: () => Effect.succeed(false),
        outcome: () => Effect.succeed(Option.none()),
        recover: () => Effect.void,
        intervene: () => Effect.void,
        interrupt: () => Effect.void,
        reserve: () => Effect.succeed({ worker: WorkerName.make("worker"), release: Effect.void }),
        occupy: (worker) => Effect.succeed({ worker, release: Effect.void }),
        execute: () => Deferred.succeed(preparing, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const engine = engineLayer(InstanceDirectory.make(root)).pipe(
        Layer.provide(slowWorker),
        Layer.provide(
          Layer.succeed(TriggerCondition)({ recheck: () => Effect.succeed("matches") }),
        ),
      );
      const observation = OperatorObservation.layer.pipe(
        Layer.provide(Layer.mergeAll(idleTriggersLayer, MarcbachmannCelLayer, WorkerStatus.idle)),
        Layer.provideMerge(engine),
      );
      yield* Effect.gen(function* () {
        const items = yield* ItemProjectionWriter;
        const runs = yield* RunEngine;
        const reads = yield* OperatorObservation;
        // Serves the overview and desk from `OperatorObservation`.
        const operator = yield* Effect.provide(
          Operator,
          Layer.mock(Operator)({ overview: reads.overview, desk: reads.desk }),
        );
        const configuration = yield* Effect.provide(
          OperatorConfiguration,
          Layer.mock(OperatorConfiguration)({}),
        );
        const backend = liveBackendLayer(
          { get: Effect.succeed(instance), reload: Effect.die("unused") },
          operator,
          configuration,
        );
        const server = HttpRouter.serve(apiRoutes.pipe(HttpRouter.provideRequest(backend)), {
          disableLogger: true,
        }).pipe(Layer.provideMerge(NodeHttpServer.layerTest));

        yield* Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          // Measured until the response body has arrived, as the web UI waits for it.
          const read = (path: string) =>
            timed(client.get(path).pipe(Effect.flatMap((response) => response.text)));
          for (let number = 1; number <= BOARD_ITEMS; number += 1)
            yield* items.upsert(issue(number));
          yield* runs.submit(started(10));
          yield* Deferred.await(preparing);

          // Each round requests the overview and desk together, as the web UI does, while the
          // projection keeps changing. The fastest round measures the read cost independent of
          // machine load.
          const rounds = [];
          for (let round = 1; round <= READS; round += 1) {
            yield* items.upsert(
              new ItemProjection({
                ...issue(1),
                contentHash: ItemContentHash.make(`issue-1-change-${round}`),
              }),
            );
            const [overview, desk] = yield* Effect.all([read("/api/overview"), read("/api/desk")], {
              concurrency: "unbounded",
            });
            rounds.push({ overview, desk });
          }

          for (const { overview, desk } of rounds) {
            assert.strictEqual(decodeOverview(overview.value)._tag, "Ready");
            assert.deepStrictEqual(
              decodeDesk(desk.value).running.map(({ item }) => item?.number),
              [ItemNumber.make(10)],
            );
          }
          const fastest = (millis: ReadonlyArray<number>) => Math.min(...millis);
          const timings = JSON.stringify(
            rounds.map(({ overview, desk }) => ({ overview: overview.millis, desk: desk.millis })),
          );
          assert.isBelow(
            fastest(rounds.map(({ overview }) => overview.millis)),
            READ_BUDGET_MILLIS,
            `fastest /api/overview response, in milliseconds, of ${timings}`,
          );
          assert.isBelow(
            fastest(rounds.map(({ desk }) => desk.millis)),
            READ_BUDGET_MILLIS,
            `fastest /api/desk response, in milliseconds, of ${timings}`,
          );
        }).pipe(Effect.provide(server));
      }).pipe(Effect.provide(observation));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
    await Effect.runPromise(program);
  }, 60_000);
});
