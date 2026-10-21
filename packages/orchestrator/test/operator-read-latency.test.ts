import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
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
import { Clock, DateTime, Deferred, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { idleTriggersLayer } from "../src/idle-triggers.ts";
import { OperatorObservation } from "../src/operator/operator.ts";
import { gitHubItemKey } from "../src/polling/repository-sync.ts";
import { WorkerStatus } from "../src/worker-status.ts";

// The dogfood instance has five Loops and about 500 Items on its Board; the
// operator's overview and desk each evaluate every Loop's trigger on every Item.
// Half that Board already takes each read past the budget when every CEL
// evaluation builds its own cel-js environment.
const BOARD_ITEMS = 250;
const LABELS = [
  "ready-for-agent",
  "agent-in-progress",
  "ready-for-review",
  "agent-review-findings",
  "review-passed",
];
// The read endpoints answer within this while an Attempt starts (#464).
const READ_BUDGET_MILLIS = 500;
const READS = 3;

const repository = RepositoryName.make("basaltbytes/usine");
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

// One Item in ten carries a Loop's label, as on a Board where most work is done.
const issue = (number: number) =>
  new ItemProjection({
    itemKey: gitHubItemKey(repository, number),
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
      labels: {
        totalCount: 1,
        nodes: [{ name: number % 10 === 0 ? LABELS[(number / 10) % LABELS.length]! : "bug" }],
      },
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
      dedupKey: DedupKey.make(`loop-0/${number}`),
      payload: { number },
      receivedAt: DateTime.makeUnsafe("2026-10-21T16:48:00Z"),
    }),
    itemKey: gitHubItemKey(repository, number),
    loop: loops[0]!.name,
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

/** How long `effect` took on the real clock, and its value. */
const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const before = yield* Clock.currentTimeMillis;
    const value = yield* effect;
    return { millis: (yield* Clock.currentTimeMillis) - before, value } as const;
  });

describe("Operator read latency", () => {
  it.live(
    `answers the overview and the desk in under ${READ_BUDGET_MILLIS} ms while an Attempt starts on a Board of ${BOARD_ITEMS} Items and five Loops`,
    () =>
      Effect.gen(function* () {
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
          reserve: () =>
            Effect.succeed({ worker: WorkerName.make("worker"), release: Effect.void }),
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
          const operator = yield* OperatorObservation;
          for (let number = 1; number <= BOARD_ITEMS; number += 1)
            yield* items.upsert(issue(number));
          yield* runs.submit(started(10));
          yield* Deferred.await(preparing);

          // While an Attempt starts, its Agent relabels Items and the engine records the
          // Attempt, so the projection revision keeps changing and each overview read
          // projects again. The fastest of a few reads measures what a read costs, not how
          // busy the machine running the tests is; a read that waited on the parked Attempt
          // would wait in every round.
          const rounds = [];
          for (let round = 1; round <= READS; round += 1) {
            yield* items.upsert(
              new ItemProjection({
                ...issue(1),
                contentHash: ItemContentHash.make(`issue-1-change-${round}`),
              }),
            );
            const overview = yield* timed(operator.overview(instance));
            const desk = yield* timed(operator.desk(instance));
            rounds.push({ overview, desk });
          }

          assert.deepStrictEqual(
            rounds.map(({ desk }) => desk.value.running.map(({ item }) => item?.number)),
            Array.from({ length: READS }, () => [ItemNumber.make(10)]),
          );
          const fastest = (millis: ReadonlyArray<number>) => Math.min(...millis);
          assert.isBelow(
            fastest(rounds.map(({ overview }) => overview.millis)),
            READ_BUDGET_MILLIS,
            "fastest overview read, in milliseconds",
          );
          assert.isBelow(
            fastest(rounds.map(({ desk }) => desk.millis)),
            READ_BUDGET_MILLIS,
            "fastest desk read, in milliseconds",
          );
        }).pipe(Effect.provide(observation));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
