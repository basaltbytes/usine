import { sqliteTempDirectory } from "../../../tooling/test/sqlite.mts";
import { ConfigurationStore } from "@usine/config/configuration";
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
  RunDetailView,
  TaskView,
} from "@usine/orchestrator/operator";
import { GitHubItemKey } from "@usine/orchestrator/polling-triggers";
import { WorkerStatus } from "@usine/orchestrator/worker-status";
import { flow, Clock, DateTime, Deferred, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { HttpClient, HttpRouter } from "effect/http";
import { assert, describe, it } from "@effect/vitest";
import { liveBackendLayer } from "../src/backend.ts";
import { apiRoutes } from "../src/http.ts";

// Pure serializers and synchronous callbacks return JSON values directly.
// @effect-diagnostics-next-line schemaSync:off
const stringifyJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

// The dogfood instance has five Loops and about 500 Items on its Board; the overview and the desk
// each evaluate every Loop's trigger on every Item, and the web UI polls both at once.
const BOARD_ITEMS = 500;
const SIZE_ITEMS = 301;
const SIZE_RUNS = 800;
const SIZE_BUDGET_BYTES = 500_000;
const longBody = "Dependency release notes and migration instructions. ".repeat(500);
const longTask = `Implement the issue.\n${longBody.repeat(4)}`;
const LABELS = [
  "ready-for-agent",
  "agent-in-progress",
  "ready-for-review",
  "agent-review-findings",
  "review-passed",
];
// CI-calibrated read latency while an attempt starts (#464).
const READ_BUDGET_MILLIS = 500;
const READS = 3;

const repository = RepositoryName.make("basaltbytes/usine");
const itemKey = (number: number) =>
  // The key contains already validated repository and item identifiers.
  // @effect-diagnostics-next-line schemaSync:off
  Schema.encodeSync(GitHubItemKey)(["github", repository, ItemNumber.make(number)]);
const brain = BrainSpec.make({
  harness: "codex",
  model: ModelId.make("gpt-6-astra"),
  effort: "medium",
});
const developer = AgentFile.make({
  name: AgentName.make("developer"),
  harness: brain.harness,
  model: brain.model,
  effort: brain.effort,
  parentModel: Option.none(),
  parentEffort: Option.none(),
  persona: AgentPersona.make("Implement the issue."),
});
const firstLoop = LoopName.make("loop-0");
const loops = LABELS.map((label, index) =>
  LoopFile.make({
    name: LoopName.make(`loop-${index}`),
    trigger: IssueTrigger.make({
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
const instance = Effect.gen(function* () {
  const decodedValue1 = yield* Schema.decodeEffect(UsineConfig)({
    version: 1,
    repos: [{ name: repository }],
    workers: [{ name: "worker", kind: "local", max_concurrent_attempts: 2 }],
  });
  return LoadedInstance.make({
    config: decodedValue1,
    agents: [developer],
    invalidAgents: [],
    loops,
    quarantinedLoops: [],
    warnings: [],
  });
});

// One Item in ten has a Loop's label, as on a Board where most work is done.
const labelOf = (number: number) =>
  number % 10 === 0 ? (LABELS[(number / 10) % LABELS.length] ?? "bug") : "bug";

const issue = (number: number) =>
  ItemProjection.make({
    itemKey: itemKey(number),
    repository,
    source: ItemProjectionSource.make("issue"),
    number: ItemNumber.make(number),
    contentHash: ItemContentHash.make(`issue-${number}`),
    payload: {
      number,
      title: `Issue ${number}`,
      body: longBody,
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
          body: longBody,
          createdAt: "2026-10-19T11:00:00Z",
          url: `https://github.com/basaltbytes/usine/issues/${number}#issuecomment-${comment}`,
        })),
      },
      closedByPullRequestsReferences: { totalCount: 0, nodes: [] },
    },
    goneAt: Option.none(),
  });

const started = (number: number) =>
  Submission.make({
    event: Event.make({
      id: EventId.make(`event-${number}`),
      dedupKey: DedupKey.make(`${firstLoop}/${number}`),
      payload: issue(number).payload,
      receivedAt: DateTime.makeUnsafe("2026-10-21T16:48:00Z"),
    }),
    itemKey: itemKey(number),
    loop: firstLoop,
    step: StepName.make("run"),
    approval: "none",
    repository,
    revision: RepositoryRevision.make("main"),
    task: AttemptTask.make(longTask),
    agent: Agent.make({
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
    const valueDecoded1 = yield* effect;
    return { millis: (yield* Clock.currentTimeMillis) - before, value: valueDecoded1 } as const;
  });

const decodeOverview = flow(
  Schema.decodeUnknownEffect(Schema.fromJsonString(FactoryOverview)),
  Effect.runSync,
);
const decodeDesk = flow(
  Schema.decodeUnknownEffect(Schema.fromJsonString(DeskView)),
  Effect.runSync,
);

describe("operator read latency", () => {
  const checkReads = ({
    initialItems,
    openRuns,
    history,
  }: {
    readonly initialItems: number;
    readonly openRuns: number;
    readonly history: boolean;
  }) =>
    Effect.gen(function* () {
      const program = Effect.gen(function* () {
        const fixtureInstance = yield* instance;
        const startedAt = yield* Clock.currentTimeMillis;
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          directory: sqliteTempDirectory(undefined, (history ? 512 : 64) * 1024 ** 2),
          prefix: "usine-read-latency-",
        });
        const preparing = yield* Deferred.make<void>();
        // A Worker whose preparation, such as an SSH preflight, lasts until the test ends.
        const slowWorker = Layer.succeed(StepExecutor)({
          workers: Effect.succeed([WorkerName.make("worker")]),
          isLive: () => Effect.succeed(false),
          outcome: () => Effect.succeedNone,
          recover: () => Effect.void,
          intervene: () => Effect.void,
          interrupt: () => Effect.void,
          reserve: () =>
            Effect.succeed({ worker: WorkerName.make("worker"), release: Effect.void }),
          occupy: (worker) => Effect.succeed({ worker, release: Effect.void }),
          sweep: Effect.void,
          discard: () => Effect.void,
          execute: () => Deferred.succeed(preparing, undefined).pipe(Effect.andThen(Effect.never)),
        });
        const engine = engineLayer(InstanceDirectory.make(root)).pipe(
          Layer.provide(slowWorker),
          Layer.provide(
            Layer.succeed(TriggerCondition)({ recheck: () => Effect.succeed("matches") }),
          ),
        );
        const observation = OperatorObservation.layer.pipe(
          Layer.provide(Layer.mock(ConfigurationStore)({})),
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
            Layer.mock(Operator)({
              overview: reads.overview,
              desk: reads.desk,
              detail: reads.detail,
              task: reads.task,
            }),
          );
          const configuration = yield* Effect.provide(
            OperatorConfiguration,
            Layer.mock(OperatorConfiguration)({}),
          );
          const backend = liveBackendLayer(
            { get: Effect.succeed(fixtureInstance) },
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
            for (let number = 1; number <= initialItems; number += 1)
              yield* items.upsert(issue(number));
            yield* runs.submit(started(1));
            yield* Deferred.await(preparing);
            for (let number = 2; number <= openRuns; number += 1)
              yield* runs.submit(Submission.make({ ...started(number), approval: "required" }));
            for (let number = 2; history && number <= SIZE_ITEMS; number += 1) {
              const count = number <= 200 ? 3 : 2;
              for (let round = 1; round <= count; round += 1) {
                const submission = started(number);
                const result = yield* runs.submit(
                  Submission.make({
                    ...submission,
                    approval: "required",
                    event: Event.make({
                      ...submission.event,
                      id: EventId.make(`event-${number}-${round}`),
                      dedupKey: DedupKey.make(`${firstLoop}/${number}/${round}`),
                    }),
                  }),
                );
                assert.strictEqual(result._tag, "Claimed");
                if (result._tag === "Claimed") yield* runs.cancel(result.runId);
              }
              const item = issue(number);
              yield* items.upsert(
                ItemProjection.make({
                  ...item,
                  contentHash: ItemContentHash.make(`issue-${number}-closed`),
                  payload: { ...item.payload, state: "CLOSED", closedAt: "2026-11-02T12:00:00Z" },
                }),
              );
            }

            const response = yield* read("/api/overview");
            const overview = decodeOverview(response.value);
            const bytes = (value: string) => new TextEncoder().encode(value).length;
            const responseBytes = bytes(response.value);
            const cards = overview.projects.flatMap(({ board }) =>
              board.lanes.flatMap(({ items }) => items),
            );
            assert.strictEqual(
              cards.filter(({ state }) => state === "issue-closed").length,
              history ? 300 : 0,
            );
            assert.strictEqual(
              cards.reduce((count, card) => count + card.runCount, 0),
              history ? SIZE_RUNS : openRuns,
            );
            assert.strictEqual(
              overview.projects.flatMap(({ board }) => board.lanes.flatMap(({ items }) => items))
                .length,
              initialItems,
            );

            // Reconstruct the previous wire shape to measure duplicated prompts by project and field.
            const withText = (run: (typeof overview.projects)[number]["runs"][number]) => ({
              ...run,
              task: longTask,
              resultMessage: null,
              attempts: run.attempts.map((attempt) => ({ ...attempt, task: longTask })),
            });
            const previousProjects = overview.projects.map((project) => ({
              ...project,
              runs: project.runs.map(withText),
              board: {
                ...project.board,
                lanes: project.board.lanes.map((lane) => ({
                  ...lane,
                  items: lane.items.map((task) => ({
                    ...task,
                    runs: [...task.runContext, ...(task.run === null ? [] : [task.run])].map(
                      withText,
                    ),
                    run: task.run === null ? null : withText(task.run),
                  })),
                })),
              },
            }));
            const decodedValue3 = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
              {
                ...overview,
                projects: previousProjects,
              },
            );
            const previousBytes = bytes(decodedValue3);
            const measurement = {
              items: initialItems,
              runs: history ? SIZE_RUNS : openRuns,
              previousBytes,
              responseBytes,
              projects: overview.projects.map((project, index) => ({
                repository: project.repository,
                before: Object.fromEntries(
                  Object.entries(previousProjects[index] ?? {}).map(([key, value]) => [
                    key,
                    bytes(stringifyJson(value)),
                  ]),
                ),
                after: Object.fromEntries(
                  Object.entries(project).map(([key, value]) => [key, bytes(stringifyJson(value))]),
                ),
              })),
            };
            const decodedValue2 = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
              measurement,
            );
            assert.isBelow(responseBytes, SIZE_BUDGET_BYTES, decodedValue2);
            assert.strictEqual(
              overview.projects.flatMap(({ runs }) => runs).length,
              history ? 51 : openRuns,
            );
            assert.isBelow(responseBytes, previousBytes * 0.1);
            yield* Effect.logInfo("Overview response size", measurement);
            const firstRun = overview.projects
              .flatMap(({ runs }) => runs)
              .find(({ state }) => state === "Running");
            assert(firstRun !== undefined);
            const detailResponse = yield* read(`/api/runs/${firstRun.id}`);
            const detail = yield* Schema.decodeEffect(Schema.fromJsonString(RunDetailView))(
              detailResponse.value,
            );
            assert.strictEqual(detail.run.task, longTask);
            assert.strictEqual(detail.run.attempts[0]?.task, longTask);
            assert.deepStrictEqual(detail.eventPayload, issue(1).payload);
            const taskResponse = yield* read(`/api/projects/basaltbytes/usine/tasks/1`);
            const task = yield* Schema.decodeEffect(Schema.fromJsonString(TaskView))(
              taskResponse.value,
            );
            assert.strictEqual(task.runs[0]?.task, longTask);
            assert.strictEqual(task.runs[0]?.attempts[0]?.task, longTask);
            if (history) {
              const doneResponse = yield* read("/api/projects/basaltbytes/usine/tasks/2");
              const doneTask = yield* Schema.decodeEffect(Schema.fromJsonString(TaskView))(
                doneResponse.value,
              );
              assert.strictEqual(doneTask.runs.length, 3);
              assert(doneTask.runs.every(({ task }) => task === longTask));
              return;
            }

            for (let number = initialItems + 1; number <= BOARD_ITEMS; number += 1)
              yield* items.upsert(issue(number));

            // Each round requests the overview and desk together, as the web UI does, while the
            // projection keeps changing. The fastest round measures the read cost independent of
            // machine load.
            const rounds = [];
            for (let round = 1; round <= READS; round += 1) {
              yield* items.upsert(
                ItemProjection.make({
                  ...issue(1),
                  contentHash: ItemContentHash.make(`issue-1-change-${round}`),
                }),
              );
              const [overview, desk] = yield* Effect.all(
                [read("/api/overview"), read("/api/desk")],
                {
                  concurrency: "unbounded",
                },
              );
              rounds.push({ overview, desk });
            }

            for (const { overview, desk } of rounds) {
              assert.strictEqual(decodeOverview(overview.value)._tag, "Ready");
              assert.deepStrictEqual(
                decodeDesk(desk.value).running.map(({ item }) => item?.number),
                [ItemNumber.make(1)],
              );
            }
            const fastest = (millis: ReadonlyArray<number>) => Math.min(...millis);
            const measurements = rounds.map(({ overview, desk }) => ({
              overview: overview.millis,
              desk: desk.millis,
            }));
            yield* Effect.logInfo("Operator read latency", { rounds: measurements });
            const timings = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
              measurements,
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

        yield* Effect.logInfo("Operator latency fixture completed", {
          history,
          elapsedMillis: (yield* Clock.currentTimeMillis) - startedAt,
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
      yield* program;
    });
  // CI-calibrated fixture setup and read budget.
  it.live.each([
    {
      fixture: "keeps 300 done tasks and 800 runs below 500 KB",
      initialItems: SIZE_ITEMS,
      openRuns: 1,
      history: true,
    },
    {
      fixture: "keeps 200 items and 50 open runs below 500 KB and concurrent reads below 500 ms",
      initialItems: 200,
      openRuns: 50,
      history: false,
    },
  ])("$fixture", checkReads, 120_000);
});
