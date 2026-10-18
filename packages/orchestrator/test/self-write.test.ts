import { assert, describe, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { AgentFile } from "@usine/config/agent";
import { UsineConfig } from "@usine/config/factory";
import { LoadedInstance } from "@usine/config/instance";
import { LoopFile, PromptTemplate } from "@usine/config/loop";
import { ConfigParser } from "@usine/config/parser";
import { IssueTrigger } from "@usine/config/trigger";
import { AgentName, AgentPersona } from "@usine/core/agent";
import { ModelId } from "@usine/core/agent/brain";
import { InstanceDirectory } from "@usine/core/instance";
import { ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { StepName } from "@usine/core/step";
import { WorkerName } from "@usine/core/worker";
import { RunReader } from "@usine/engine/run-reader";
import { StepExecutor } from "@usine/engine/step-executor";
import { layer as localEngineLayer } from "@usine/engine/local-sqlite";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { Source } from "@usine/expression/expression-engine";
import { GitHubItemWriter } from "@usine/github/item-writer";
import {
  GitHubApiError,
  GitHubRateLimitError,
  type GitHubAppError,
} from "@usine/github/github-app";
import {
  ChangedIssue,
  ContentHash,
  GitHubPolling,
  IssueSnapshot,
  RepositoryChanges,
  RepositoryLabelCatalog,
  type IssuePayload,
} from "@usine/github/polling";
import {
  Clock,
  DateTime,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Schedule,
  Schema,
} from "effect";
import { BoardLaneId, BoardMove } from "../src/operator/board.ts";
import { Operator } from "../src/operator/operator.ts";
import { PollingTriggers } from "../src/polling-triggers.ts";
import { ScheduleTriggers } from "../src/schedule-triggers.ts";
import { alwaysHoldsLayer, inertLabelReconcilerLayer } from "./support/polling.ts";

const repository = RepositoryName.make("basaltbytes/usine");
const agent = new AgentFile({
  name: AgentName.make("developer"),
  harness: "codex",
  model: ModelId.make("gpt-6-astra"),
  effort: "medium",
  parentModel: Option.none(),
  parentEffort: Option.none(),
  persona: AgentPersona.make("Implement the issue."),
});
const instance = new LoadedInstance({
  config: Schema.decodeUnknownSync(UsineConfig)({
    version: 1,
    repos: [
      {
        name: repository,
        lanes: [
          { name: "Ready", sources: [{ label: "ready" }] },
          { name: "Backlog", sources: [{ label: "backlog" }] },
        ],
      },
    ],
    settings: { poll_interval: 60 },
  }),
  agents: [agent],
  invalidAgents: [],
  quarantinedLoops: [],
  warnings: [],
  loops: [
    new LoopFile({
      name: LoopName.make("start-dev"),
      trigger: new IssueTrigger({
        on: "issue",
        if: Source.make('item.labels.nodes.exists(label, label.name == "ready")'),
      }),
      selector: Option.none(),
      approval: "required",
      step: StepName.make("run"),
      agent: agent.name,
      body: PromptTemplate.make("Implement issue {{ item.number }}."),
    }),
  ],
});
const payload = (labels: ReadonlyArray<string>): IssuePayload => ({
  number: 74,
  title: "Online backup",
  body: "Allow an online backup.",
  url: "https://github.com/basaltbytes/usine/issues/74",
  state: "OPEN",
  stateReason: null,
  createdAt: "2026-09-06T10:00:00Z",
  updatedAt: "2026-09-06T12:00:00Z",
  closedAt: null,
  author: { login: "operator" },
  issueType: null,
  milestone: null,
  labels: { totalCount: labels.length, nodes: labels.map((name) => ({ name })) },
  assignees: { totalCount: 0, nodes: [] },
  comments: { totalCount: 0, nodes: [] },
  closedByPullRequestsReferences: { totalCount: 0, nodes: [] },
});

const awaitCondition = <A, E>(effect: Effect.Effect<A, E>, until: (value: A) => boolean) =>
  effect.pipe(
    Effect.repeat({ until, schedule: Schedule.spaced("10 millis") }),
    Effect.timeout("3 seconds"),
  );

describe("Board self-writes", () => {
  for (const outcome of ["success", "partial failure", "rate limit"] as const) {
    it.live(
      `reconciles a Board write after ${outcome} and opens one approval before the next poll`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = InstanceDirectory.make(
            yield* fs.makeTempDirectoryScoped({ prefix: "usine-self-write-" }),
          );
          let labels: ReadonlyArray<string> = ["backlog"];
          let writeFailure: Option.Option<GitHubAppError> = Option.none();
          let changeRequests = 0;
          const github: GitHubPolling["Service"] = {
            changes: (_repository, cursor) =>
              Effect.gen(function* () {
                changeRequests += 1;
                const now = yield* Clock.currentTimeMillis;
                return new RepositoryChanges({
                  cursor,
                  items: [new ChangedIssue({ number: 74, updatedAt: DateTime.makeUnsafe(now) })],
                  backlog: false,
                  nextPollAt: Option.some(DateTime.makeUnsafe(now + 60_000)),
                });
              }),
            labels: () =>
              Effect.succeed(new RepositoryLabelCatalog({ entityTag: Option.none(), labels: [] })),
            snapshot: () =>
              Effect.gen(function* () {
                if (
                  Option.isSome(writeFailure) &&
                  writeFailure.value._tag === "GitHubRateLimitError"
                ) {
                  assert(
                    (yield* Clock.currentTimeMillis) >=
                      DateTime.toEpochMillis(writeFailure.value.retryAt),
                    "a writer rate limit prevents an early reconciliation snapshot",
                  );
                }
                return new IssueSnapshot({
                  payload: payload(labels),
                  contentHash: ContentHash.make((labels.includes("ready") ? "b" : "a").repeat(64)),
                });
              }),
          };
          const writer = Layer.succeed(GitHubItemWriter)({
            updateLabels: (_repository, _item, mutation) =>
              Effect.gen(function* () {
                labels = [...new Set([...labels, ...mutation.add])];
                if (outcome !== "success") {
                  const error =
                    outcome === "rate limit"
                      ? new GitHubRateLimitError({
                          operation: "update-item-labels",
                          retryAt: DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 300),
                          message: "Wait before removing the source label",
                        })
                      : new GitHubApiError({
                          operation: "update-item-labels",
                          status: Option.some(503),
                          message: "Destination added; source deletion failed",
                        });
                  writeFailure = Option.some(error);
                  return yield* error;
                }
                labels = labels.filter((label) => !mutation.remove.includes(label));
                return labels;
              }),
          });
          const executor = Layer.succeed(StepExecutor)({
            workers: [WorkerName.make("local")],
            isLive: () => Effect.succeed(false),
            outcome: () => Effect.succeed(Option.none()),
            recover: () => Effect.void,
            intervene: () => Effect.void,
            interrupt: () => Effect.void,
            reserve: () => Effect.die("approval must precede worker reservation"),
            execute: () => Effect.die("approval must precede an Attempt"),
          });
          const engine = localEngineLayer(directory).pipe(
            Layer.provide(executor),
            Layer.provide(alwaysHoldsLayer),
          );
          const dependencies = Layer.mergeAll(
            engine,
            writer,
            MarcbachmannCelLayer,
            ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer)),
            inertLabelReconcilerLayer,
            Layer.succeed(GitHubPolling, github),
            Layer.succeed(ScheduleTriggers)({
              latest: Effect.succeed(Option.none()),
              run: () => Effect.never,
              tick: () => Effect.die("unused"),
            }),
          );
          const pollingLayer = PollingTriggers.layer.pipe(Layer.provideMerge(dependencies));
          const layer = Operator.layer.pipe(Layer.provideMerge(pollingLayer));
          yield* Effect.gen(function* () {
            const polling = yield* PollingTriggers;
            const operator = yield* Operator;
            const reader = yield* RunReader;
            const fiber = yield* polling.run(instance).pipe(Effect.forkChild);
            yield* awaitCondition(polling.latest, Option.isSome);
            assert.strictEqual(changeRequests, 1);
            const move = new BoardMove({
              repository,
              item: ItemNumber.make(74),
              toLane: BoardLaneId.make("authored:Ready"),
            });
            const applyMove = Effect.gen(function* () {
              if (outcome === "success") return yield* operator.moveBoardItem(instance, move);
              const error = yield* operator.moveBoardItem(instance, move).pipe(Effect.flip);
              assert(Option.isSome(writeFailure));
              assert.strictEqual(
                error,
                writeFailure.value,
                "the original writer failure reaches the caller",
              );
            });
            yield* applyMove;
            const overview = yield* awaitCondition(operator.overview(instance), (value) =>
              value.projects.some((project) => project.runs.some((run) => run.state === "Waiting")),
            );
            assert.strictEqual(overview.projects[0]?.runs.length, 1);
            assert.strictEqual(
              overview.projects[0]?.board.lanes.find((lane) => lane.id === move.toLane)?.items[0]
                ?.number,
              74,
            );
            assert.strictEqual(
              changeRequests,
              1,
              "a self-write fetches the moved Item without repeating conditional change detection",
            );
            const waiting = overview.projects[0]?.runs[0];
            assert(waiting !== undefined);
            yield* applyMove;
            yield* polling.poll(instance);
            const runs = yield* reader.list({ closedLimit: 10 });
            assert.strictEqual(runs.length, 1);
            assert.strictEqual(runs[0]?.run.id, waiting.id);
            assert.strictEqual(runs[0]?.attempts.length, 0);
            yield* Fiber.interrupt(fiber);
          }).pipe(Effect.provide(layer));
        }).pipe(Effect.provide(NodeServices.layer)),
    );
  }
});
