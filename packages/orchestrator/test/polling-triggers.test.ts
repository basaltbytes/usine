import { noCycleBudgets } from "./support/polling.ts";
import { fixedInstanceLayer } from "./support/current-instance.ts";
import { reloadableInstanceLayer, writeInstanceFiles } from "./support/instance-folder.ts";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { ModelId } from "@usine/core/agent/brain";
import { AgentName, AgentPersona } from "@usine/core/agent";
import { DedupKey, Event, EventId } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { StepName } from "@usine/core/step";
import { StepResult } from "@usine/core/step/result";
import { WorkerName } from "@usine/core/worker";
import { AgentFile } from "@usine/config/agent";
import { ConfigFileError, InstancePath } from "@usine/config/file";
import { IssueTrigger, PullRequestTrigger } from "@usine/config/trigger";
import { LoadedInstance } from "@usine/config/instance";
import { LoopFile, PromptTemplate } from "@usine/config/loop";
import { LoopName } from "@usine/core/loop";
import { Selector } from "@usine/config/selector";
import { UsineConfig } from "@usine/config/factory";
import { ConfigParser } from "@usine/config/parser";
import { InstanceDirectory } from "@usine/core/instance";
import { CursorKey, CursorStore } from "@usine/engine/cursor";
import { RunEngine, Claimed, EnginePersistenceError } from "@usine/engine/engine";
import { LoopControl } from "@usine/engine/loop-control";
import {
  ItemProjectionReader,
  ItemProjectionWriter,
  type ItemProjection,
} from "@usine/engine/item-projection";
import { RepositoryLabelProjectionReader } from "@usine/engine/repository-label-projection";
import { RunReader } from "@usine/engine/run-reader";
import { StepExecutor } from "@usine/engine/step-executor";
import type { TriggerCondition } from "@usine/engine/trigger-condition";
import { layer as localEngineLayer } from "@usine/engine/local-sqlite";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { Source } from "@usine/expression/expression-engine";
import { GitHubApiError, GitHubRateLimitError } from "@usine/github/github-app";
import {
  ChangedIssue,
  ChangedPullRequest,
  PullRequestPayload,
  PullRequestSnapshot,
  ContentHash,
  EntityTag,
  type IssuePayload,
  IssueSnapshot,
  PollCursor,
  RepositoryChanges,
  RepositoryLabel,
  RepositoryLabelCatalog,
  RepositoryLabelColor,
  RepositoryLabelName,
  RepositoryLabelsNotModified,
  RepositoryNotModified,
  GitHubItemNotFoundError,
  GitHubPolling,
} from "@usine/github/polling";
import {
  Context,
  Clock,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Ref,
  Schema,
  Scope,
} from "effect";
import { TestClock } from "effect/testing";
import { CurrentInstance } from "../src/current-instance/current-instance.ts";
import { PollingTriggers } from "../src/polling-triggers.ts";
import { triggerConditionLayer } from "../src/trigger-condition.ts";
import {
  alwaysHoldsLayer,
  inertGitHubLabelWriterLayer,
  inertLabelReconcilerLayer,
  itemProjectionWriterLayer,
  loopControlLayer,
  memoryCursorStore,
  pollingTestLayer,
  repositoryLabelProjectionReaderLayer,
  repositoryLabelProjectionWriterLayer,
} from "./support/polling.ts";

const watchedRepository = RepositoryName.make("basaltbytes/usine");
const emptyLabelCatalog = new RepositoryLabelCatalog({
  entityTag: Option.none(),
  labels: [],
});

const config = Schema.decodeUnknownSync(UsineConfig)({
  version: 1,
  repos: [
    { name: watchedRepository, tags: ["active"] },
    { name: "basaltbytes/unwatched", tags: ["inactive"] },
  ],
  settings: { poll_interval: 60, parent_model: "anthropic/instance-parent" },
});

const agent = new AgentFile({
  name: AgentName.make("developer"),
  harness: "codex",
  model: ModelId.make("gpt-5.6-sol"),
  effort: "high",
  parentModel: Option.none(),
  parentEffort: Option.none(),
  persona: AgentPersona.make("Implement the issue."),
});

const issueLoop = (name: string) =>
  new LoopFile({
    name: LoopName.make(name),
    trigger: new IssueTrigger({
      on: "issue",
      if: Source.make(
        'item.state == "OPEN" && item.labels.nodes.exists(label, label.name == "ready")',
      ),
    }),
    selector: Option.some(
      new Selector({
        repos: Option.some([config.repos[0]?.name ?? assert.fail("missing watched repo")]),
        tags: Option.none(),
      }),
    ),
    approval: "required",
    step: StepName.make("run"),
    agent: agent.name,
    body: PromptTemplate.make("Implement issue {{ item.number }}."),
  });

const instanceWith = (loops: ReadonlyArray<LoopFile>) =>
  new LoadedInstance({
    config,
    agents: [agent],
    invalidAgents: [],
    loops,
    quarantinedLoops: [],
    warnings: [],
  });

const issuePayload = (labels: ReadonlyArray<string>, number = 28): IssuePayload => ({
  number,
  title: "Polling triggers",
  body: "Build the trigger path.",
  url: "https://github.com/basaltbytes/usine/issues/28",
  state: "OPEN",
  stateReason: null,
  createdAt: "2026-08-30T10:00:00Z",
  updatedAt: "2026-08-30T20:00:00Z",
  closedAt: null,
  author: { login: "PhilDL" },
  issueType: null,
  milestone: null,
  labels: { totalCount: labels.length, nodes: labels.map((name) => ({ name })) },
  assignees: { totalCount: 0, nodes: [] },
  comments: { totalCount: 0, nodes: [] },
  closedByPullRequestsReferences: { totalCount: 0, nodes: [] },
});

interface RemoteState {
  readonly hash: ContentHash;
  readonly payload: IssuePayload;
}

const waitForState = Effect.fn("test.waitForState")(function* (
  engine: RunEngine["Service"],
  runId: RunId,
  tag: "Canceled" | "Running" | "Succeeded" | "Waiting",
) {
  for (let poll = 0; poll < 500; poll += 1) {
    const snapshot = yield* engine.inspect(runId);
    if (snapshot.run.state._tag === tag) return snapshot;
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die(`Run ${runId} did not reach ${tag}`);
});

const claimedRun = (cycle: Effect.Success<ReturnType<PollingTriggers["Service"]["poll"]>>) => {
  const submission = cycle.submissions[0];
  assert(submission !== undefined && submission._tag === "Claimed");
  return submission.runId;
};

const gatedExecutor = Layer.succeed(StepExecutor)({
  workers: [WorkerName.make("local")],
  isLive: () => Effect.succeed(false),
  outcome: () => Effect.succeed(Option.none()),
  recover: () => Effect.void,
  intervene: () => Effect.void,
  interrupt: () => Effect.void,
  reserve: () => Effect.die("an approval-gated test run must not reserve a worker"),
  execute: () => Effect.die("an approval-gated test run must not start an Attempt"),
});

const runtimeLayer = (
  directory: InstanceDirectory,
  github: GitHubPolling["Service"],
  executor: Layer.Layer<StepExecutor> = gatedExecutor,
  condition: Layer.Layer<TriggerCondition> = alwaysHoldsLayer,
) => {
  const engine = localEngineLayer(directory).pipe(
    Layer.provide(executor),
    Layer.provide(condition),
  );
  const parser = ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer));
  const dependencies = Layer.mergeAll(
    engine,
    MarcbachmannCelLayer,
    parser,
    inertGitHubLabelWriterLayer,
    inertLabelReconcilerLayer,
    Layer.succeed(GitHubPolling, github),
  );
  return Layer.merge(dependencies, PollingTriggers.layer.pipe(Layer.provide(dependencies)));
};

describe("PollingTriggers", () => {
  it.live("refreshes open PR mergeability after restart despite unchanged issue detection", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-mergeability-" }),
      );
      const loop = new LoopFile({
        ...issueLoop("rebase-pr"),
        trigger: new PullRequestTrigger({
          on: "pr",
          if: Source.make('item.state == "OPEN" && item.mergeable == "CONFLICTING"'),
        }),
      });
      const instance = instanceWith([loop]);
      let mergeable = "UNKNOWN";
      let state = "OPEN";
      let snapshots = 0;
      const github: GitHubPolling["Service"] = {
        labels: () => Effect.succeed(emptyLabelCatalog),
        changes: (repository, cursor) =>
          Effect.succeed(
            repository === watchedRepository && Option.isNone(cursor.entityTag)
              ? new RepositoryChanges({
                  cursor: new PollCursor({
                    entityTag: Option.some(EntityTag.make('W/"unchanged"')),
                    watermark: Option.some(DateTime.makeUnsafe("2026-08-30T20:00:00Z")),
                  }),
                  items: [
                    new ChangedPullRequest({
                      number: 28,
                      updatedAt: DateTime.makeUnsafe("2026-08-30T20:00:00Z"),
                    }),
                  ],
                  backlog: false,
                  nextPollAt: Option.none(),
                })
              : new RepositoryNotModified({ cursor, nextPollAt: Option.none() }),
          ),
        snapshot: () =>
          Effect.sync(() => {
            snapshots += 1;
            return new PullRequestSnapshot({
              contentHash: ContentHash.make(
                (state === "CLOSED"
                  ? "d"
                  : mergeable === "UNKNOWN"
                    ? "a"
                    : mergeable === "CONFLICTING"
                      ? "b"
                      : "c"
                ).repeat(64),
              ),
              payload: Schema.decodeUnknownSync(PullRequestPayload)({
                ...issuePayload([]),
                state,
                mergeable,
                mergeStateStatus: "UNKNOWN",
                isDraft: false,
                merged: false,
                mergedAt: null,
                baseRefName: "main",
                headRefName: "feature",
                headRefOid: "a".repeat(40),
                additions: 1,
                deletions: 0,
                changedFiles: 1,
                reviewDecision: null,
                statusCheckRollup: null,
                reviewThreads: { totalCount: 0, nodes: [] },
                reviewRequests: { totalCount: 0, nodes: [] },
                reviews: { totalCount: 0, nodes: [] },
                closingIssuesReferences: { totalCount: 0, nodes: [] },
              }),
            });
          }),
      };
      yield* Effect.gen(function* () {
        const polling = yield* PollingTriggers;
        const initial = yield* polling.poll(instance);
        assert.deepStrictEqual(initial.failures, []);
        assert.strictEqual(initial.submissions.length, 0);
        assert.strictEqual(snapshots, 1);
      }).pipe(Effect.provide(runtimeLayer(directory, github)));

      // Rebuild the entire runtime: the open PR set must be durable.
      yield* Effect.gen(function* () {
        const polling = yield* PollingTriggers;
        const engine = yield* RunEngine;
        const items = yield* ItemProjectionReader;
        mergeable = "CONFLICTING";
        const conflict = yield* polling.poll(instance);
        assert.deepStrictEqual(conflict.failures, []);
        assert.strictEqual(conflict.submissions.length, 1);
        const run = claimedRun(conflict);
        yield* waitForState(engine, run, "Waiting");
        assert.strictEqual(
          (yield* items.list(watchedRepository, { limit: 10 }))[0]?.payload.mergeable,
          "CONFLICTING",
        );
        const unchanged = yield* polling.poll(instance);
        assert.strictEqual(claimedRun(unchanged), run);
        // A refresh is not a detected change: idle polls must not look busy.
        assert.strictEqual(unchanged.changedItems, 0);
        mergeable = "MERGEABLE";
        const fixed = yield* polling.poll(instance);
        assert.strictEqual(fixed.submissions.length, 0);
        assert.strictEqual(fixed.revokedRuns, 1);
        yield* waitForState(engine, run, "Canceled");
        assert.strictEqual(
          (yield* items.list(watchedRepository, { limit: 10 }))[0]?.payload.mergeable,
          "MERGEABLE",
        );
        state = "CLOSED";
        yield* polling.poll(instance);
        assert.strictEqual(snapshots, 5);
        yield* polling.poll(instance);
        assert.strictEqual(snapshots, 5);
      }).pipe(Effect.provide(runtimeLayer(directory, github)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("drops an open pull request GitHub no longer has and revokes its unstarted Run", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-missing-pr-" }),
      );
      const instance = instanceWith([
        new LoopFile({
          ...issueLoop("review-pr"),
          trigger: new PullRequestTrigger({ on: "pr", if: Source.make('item.state == "OPEN"') }),
        }),
      ]);
      let gone = false;
      let fetches = 0;
      const github: GitHubPolling["Service"] = {
        labels: () => Effect.succeed(emptyLabelCatalog),
        changes: (repository, cursor) =>
          Effect.succeed(
            repository === watchedRepository && Option.isNone(cursor.entityTag)
              ? new RepositoryChanges({
                  cursor: new PollCursor({
                    entityTag: Option.some(EntityTag.make('W/"unchanged"')),
                    watermark: Option.some(DateTime.makeUnsafe("2026-08-30T20:00:00Z")),
                  }),
                  items: [
                    new ChangedPullRequest({
                      number: 28,
                      updatedAt: DateTime.makeUnsafe("2026-08-30T20:00:00Z"),
                    }),
                  ],
                  backlog: false,
                  nextPollAt: Option.none(),
                })
              : new RepositoryNotModified({ cursor, nextPollAt: Option.none() }),
          ),
        snapshot: (repository, item) =>
          Effect.suspend(() => {
            fetches += 1;
            return gone
              ? Effect.fail(
                  new GitHubItemNotFoundError({
                    operation: "fetch-pull-request-snapshot",
                    item: item.number,
                    message: `GitHub has no pull request ${item.number} in ${repository}`,
                  }),
                )
              : Effect.succeed(
                  new PullRequestSnapshot({
                    contentHash: ContentHash.make("a".repeat(64)),
                    payload: Schema.decodeUnknownSync(PullRequestPayload)({
                      ...issuePayload([]),
                      mergeable: "MERGEABLE",
                      mergeStateStatus: "CLEAN",
                      isDraft: false,
                      merged: false,
                      mergedAt: null,
                      baseRefName: "main",
                      headRefName: "feature",
                      headRefOid: "a".repeat(40),
                      additions: 1,
                      deletions: 0,
                      changedFiles: 1,
                      reviewDecision: null,
                      statusCheckRollup: null,
                      reviewThreads: { totalCount: 0, nodes: [] },
                      reviewRequests: { totalCount: 0, nodes: [] },
                      reviews: { totalCount: 0, nodes: [] },
                      closingIssuesReferences: { totalCount: 0, nodes: [] },
                    }),
                  }),
                );
          }),
      };
      yield* Effect.gen(function* () {
        const polling = yield* PollingTriggers;
        const engine = yield* RunEngine;
        const run = claimedRun(yield* polling.poll(instance));
        yield* waitForState(engine, run, "Waiting");

        gone = true;
        const dropped = yield* polling.poll(instance);
        assert.deepStrictEqual(dropped.failures, []);
        assert.strictEqual(dropped.revokedRuns, 1);
        const revoked = yield* waitForState(engine, run, "Canceled");
        assert(revoked.run.state._tag === "Canceled");
        assert.strictEqual(revoked.run.state.reason._tag, "Revoked");

        // The cursor no longer holds the pull request, so it is not fetched again.
        const after = yield* polling.poll(instance);
        assert.deepStrictEqual(after.failures, []);
        assert.strictEqual(fetches, 2);
      }).pipe(Effect.provide(runtimeLayer(directory, github)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("opens exactly one finish Run when the finisher pushes before it relabels", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-finisher-" }),
      );
      const loop = new LoopFile({
        ...issueLoop("finish-pr"),
        trigger: new PullRequestTrigger({
          on: "pr",
          if: Source.make(
            'item.state == "OPEN" && !item.labels.nodes.exists(label, label.name == "ready-to-merge") && item.labels.nodes.exists(label, label.name == "review-passed")',
          ),
        }),
        approval: "none",
        body: PromptTemplate.make("Finish pull request {{ item.number }}."),
      });
      const instance = instanceWith([loop]);
      // The PR as GitHub reports it; the finisher Run mutates it mid-flight.
      const remote = { head: "a", labels: ["review-passed"] };
      let snapshots = 0;
      const github: GitHubPolling["Service"] = {
        labels: () => Effect.succeed(emptyLabelCatalog),
        changes: (repository, cursor) =>
          Effect.succeed(
            repository === watchedRepository
              ? new RepositoryChanges({
                  cursor,
                  items: [
                    new ChangedPullRequest({
                      number: 162,
                      updatedAt: DateTime.makeUnsafe("2026-09-18T04:08:10Z"),
                    }),
                  ],
                  backlog: false,
                  nextPollAt: Option.none(),
                })
              : new RepositoryNotModified({ cursor, nextPollAt: Option.none() }),
          ),
        snapshot: () =>
          Effect.sync(() => {
            snapshots += 1;
            const relabeled = remote.labels.includes("ready-to-merge");
            return new PullRequestSnapshot({
              contentHash: ContentHash.make(`${remote.head}${relabeled ? "f" : "0"}`.repeat(32)),
              payload: Schema.decodeUnknownSync(PullRequestPayload)({
                ...issuePayload(remote.labels, 162),
                state: "OPEN",
                mergeable: "MERGEABLE",
                mergeStateStatus: "CLEAN",
                isDraft: false,
                merged: false,
                mergedAt: null,
                baseRefName: "main",
                headRefName: "fix/162",
                headRefOid: remote.head.repeat(40),
                additions: 1,
                deletions: 0,
                changedFiles: 1,
                reviewDecision: null,
                statusCheckRollup: null,
                reviewThreads: { totalCount: 0, nodes: [] },
                reviewRequests: { totalCount: 0, nodes: [] },
                reviews: { totalCount: 0, nodes: [] },
                closingIssuesReferences: { totalCount: 0, nodes: [] },
              }),
            });
          }),
      };
      const finishing = yield* Deferred.make<void>();
      let executions = 0;
      const executor = Layer.succeed(StepExecutor)({
        workers: [WorkerName.make("local")],
        isLive: () => Effect.succeed(false),
        outcome: () => Effect.succeed(Option.none()),
        recover: () => Effect.void,
        intervene: () => Effect.void,
        interrupt: () => Effect.void,
        reserve: () => Effect.succeed({ worker: WorkerName.make("local"), release: Effect.void }),
        execute: () =>
          Effect.gen(function* () {
            executions += 1;
            if (executions > 1) return yield* Effect.die("a second finish Run must not start");
            yield* Deferred.await(finishing);
            return new StepResult({ message: "Finished", facts: [] });
          }),
      });
      const condition = triggerConditionLayer.pipe(
        Layer.provide(Layer.succeed(GitHubPolling, github)),
        Layer.provide(MarcbachmannCelLayer),
        Layer.provide(fixedInstanceLayer(instance)),
      );

      yield* Effect.gen(function* () {
        const polling = yield* PollingTriggers;
        const engine = yield* RunEngine;
        const reader = yield* RunReader;
        const itemKey = ItemKey.make(JSON.stringify(["github", watchedRepository, 162]));

        const reviewPassed = yield* polling.poll(instance);
        const finishRun = claimedRun(reviewPassed);
        yield* waitForState(engine, finishRun, "Running");

        // The finisher pushes its fix; the poll between the push and the
        // relabel sees new content with review-passed still set.
        remote.head = "b";
        const pushed = yield* polling.poll(instance);
        assert.strictEqual(pushed.submissions[0]?._tag, "Queued");

        // The finisher relabels and exits before the next poll.
        remote.labels = ["ready-to-merge"];
        const beforeClose = snapshots;
        yield* Deferred.succeed(finishing, undefined);
        yield* waitForState(engine, finishRun, "Succeeded");
        for (let poll = 0; poll < 500 && snapshots === beforeClose; poll += 1) {
          yield* Effect.sleep("10 millis");
        }
        // The queued Event was re-checked against the relabeled PR, not opened.
        assert.strictEqual(snapshots, beforeClose + 1);

        const relabeled = yield* polling.poll(instance);
        assert.strictEqual(relabeled.submissions.length, 0);
        assert.strictEqual(relabeled.revokedRuns, 0);
        const runs = yield* reader.forItems([itemKey]);
        assert.deepStrictEqual(
          runs.map(({ run }) => run.id),
          [finishRun],
        );
        assert.strictEqual(executions, 1);
      }).pipe(Effect.provide(runtimeLayer(directory, github, executor, condition)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("waits past poll_interval when GitHub recommends a longer delay", () => {
    let changeRequests = 0;
    const github: GitHubPolling["Service"] = {
      changes: (_repository, cursor) =>
        Effect.gen(function* () {
          changeRequests += 1;
          const now = yield* Clock.currentTimeMillis;
          return new RepositoryNotModified({
            cursor,
            nextPollAt: Option.some(DateTime.makeUnsafe(now + 120_000)),
          });
        }),
      labels: () => Effect.succeed(emptyLabelCatalog),
      snapshot: () => Effect.die("an unchanged repository has no snapshots"),
    };

    return Effect.gen(function* () {
      const polling = yield* PollingTriggers;
      const fiber = yield* Effect.forkChild(
        polling.run(Effect.succeed(instanceWith([issueLoop("start-dev")]))),
      );
      yield* Effect.yieldNow;
      assert.strictEqual(changeRequests, 2);
      yield* TestClock.adjust("119 seconds");
      assert.strictEqual(changeRequests, 2);
      yield* TestClock.adjust("1 second");
      assert.strictEqual(changeRequests, 4);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(pollingTestLayer(github)));
  });

  it.effect(
    "reads the current instance at each cycle, so a reload applies from the next one",
    () => {
      const polled: Array<string> = [];
      const github: GitHubPolling["Service"] = {
        changes: (repository, cursor) =>
          Effect.sync(() => {
            polled.push(repository);
            return new RepositoryNotModified({ cursor, nextPollAt: Option.none() });
          }),
        labels: () => Effect.succeed(emptyLabelCatalog),
        snapshot: () => Effect.die("an unchanged repository has no snapshots"),
      };
      const onlyWatched = new LoadedInstance({
        ...instanceWith([]),
        config: new UsineConfig({ ...config, repos: config.repos.slice(0, 1) }),
      });

      return Effect.gen(function* () {
        const polling = yield* PollingTriggers;
        const current = yield* Ref.make(onlyWatched);
        const fiber = yield* Effect.forkChild(polling.run(Ref.get(current)));
        yield* Effect.yieldNow;
        assert.deepStrictEqual(polled, [watchedRepository]);
        yield* Ref.set(current, instanceWith([]));
        yield* TestClock.adjust("60 seconds");
        assert.deepStrictEqual(polled, [
          watchedRepository,
          watchedRepository,
          "basaltbytes/unwatched",
        ]);
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(pollingTestLayer(github)));
    },
  );

  it.live(
    "keeps Board Items current for paused Loops and repositories without matching Loops",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = InstanceDirectory.make(
          yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-paused-polling-" }),
        );
        const loop = issueLoop("paused-issues");
        const payload = issuePayload(["ready"]);
        const github: GitHubPolling["Service"] = {
          changes: (_repository, cursor) =>
            Effect.succeed(
              new RepositoryChanges({
                cursor,
                items: [
                  new ChangedIssue({
                    number: 28,
                    updatedAt: DateTime.makeUnsafe("2026-08-30T20:00:00Z"),
                  }),
                ],
                backlog: false,
                nextPollAt: Option.none(),
              }),
            ),
          labels: () => Effect.succeed(emptyLabelCatalog),
          snapshot: () =>
            Effect.succeed(
              new IssueSnapshot({
                payload,
                contentHash: ContentHash.make("a".repeat(64)),
              }),
            ),
        };

        yield* Effect.gen(function* () {
          const polling = yield* PollingTriggers;
          const controls = yield* LoopControl;
          const items = yield* ItemProjectionReader;
          yield* controls.pause(loop.name);
          const cycle = yield* polling.poll(instanceWith([loop]));
          assert.strictEqual(cycle.repositories, 2);
          assert.strictEqual(cycle.changedItems, 2);
          assert.strictEqual(cycle.submissions.length, 0);
          assert.deepStrictEqual(cycle.failures, []);
          for (const repository of config.repos) {
            const projected = yield* items.list(repository.name, { limit: 10 });
            assert.strictEqual(projected.length, 1);
            assert.deepStrictEqual(projected[0]?.payload, payload);
          }
          const latest = yield* polling.latest;
          assert(Option.isSome(latest));
          assert.strictEqual(latest.value, cycle);
        }).pipe(Effect.provide(runtimeLayer(directory, github)));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("turns a rate-limited label catalog into a backoff, not a failed cycle", () => {
    const github: GitHubPolling["Service"] = {
      changes: (_repository, cursor) =>
        Effect.succeed(new RepositoryNotModified({ cursor, nextPollAt: Option.none() })),
      labels: () =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          return yield* new GitHubRateLimitError({
            operation: "list-repository-labels",
            retryAt: DateTime.makeUnsafe(now + 90_000),
            message: "secondary rate limit",
          });
        }),
      snapshot: () => Effect.die("an unchanged repository has no snapshots"),
    };

    return Effect.gen(function* () {
      const polling = yield* PollingTriggers;
      const cycle = yield* polling.poll(instanceWith([issueLoop("start-dev")]));
      assert.strictEqual(cycle.repositories, 2);
      assert.strictEqual(cycle.failures.length, 0);
      const now = yield* Clock.currentTimeMillis;
      assert(Option.isSome(cycle.nextPollAt));
      assert.strictEqual(DateTime.toEpochMillis(cycle.nextPollAt.value), now + 90_000);
    }).pipe(Effect.provide(pollingTestLayer(github)));
  });

  it.live("keeps firing Loops and advancing the cursor when the label catalog request fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-polling-" }),
      );
      const catalogFails = yield* Ref.make(false);
      const hash = yield* Ref.make(ContentHash.make("a".repeat(64)));
      const cursorsSeen = yield* Ref.make<ReadonlyArray<Option.Option<EntityTag>>>([]);
      const cursorsReturned = yield* Ref.make<ReadonlyArray<EntityTag>>([]);
      const labelEntityTagsSeen = yield* Ref.make<ReadonlyArray<Option.Option<EntityTag>>>([]);
      const catalogEntityTag = EntityTag.make('W/"labels"');
      const changed = new ChangedIssue({
        number: 28,
        updatedAt: DateTime.makeUnsafe("2026-08-30T20:00:00Z"),
      });
      const recordFor =
        <A>(repository: RepositoryName, ref: Ref.Ref<ReadonlyArray<A>>) =>
        (value: A) =>
          repository === watchedRepository
            ? Ref.update(ref, (values) => [...values, value])
            : Effect.void;
      const github: GitHubPolling["Service"] = {
        changes: (repository, cursor) =>
          Effect.gen(function* () {
            yield* recordFor(repository, cursorsSeen)(cursor.entityTag);
            const entityTag = EntityTag.make(
              `W/"${repository}-${String((yield* Ref.get(cursorsReturned)).length)}"`,
            );
            yield* recordFor(repository, cursorsReturned)(entityTag);
            return new RepositoryChanges({
              cursor: new PollCursor({
                entityTag: Option.some(entityTag),
                watermark: Option.some(changed.updatedAt),
              }),
              items: [changed],
              backlog: false,
              nextPollAt: Option.none(),
            });
          }),
        labels: (repository, entityTag) =>
          Effect.gen(function* () {
            yield* recordFor(repository, labelEntityTagsSeen)(entityTag);
            if (yield* Ref.get(catalogFails)) {
              return yield* new GitHubApiError({
                operation: "list-repository-labels",
                status: Option.some(502),
                message: "label catalog unavailable",
              });
            }
            return new RepositoryLabelCatalog({
              entityTag: Option.some(catalogEntityTag),
              labels: [
                new RepositoryLabel({
                  name: RepositoryLabelName.make("ready"),
                  color: RepositoryLabelColor.make("0E8A16"),
                  description: Option.none(),
                }),
              ],
            });
          }),
        snapshot: () =>
          Effect.gen(function* () {
            return new IssueSnapshot({
              payload: issuePayload(["ready"]),
              contentHash: yield* Ref.get(hash),
            });
          }),
      };
      const context = yield* Layer.build(runtimeLayer(directory, github));
      const polling = Context.get(context, PollingTriggers);
      const engine = Context.get(context, RunEngine);
      const labels = Context.get(context, RepositoryLabelProjectionReader);
      const instance = instanceWith([issueLoop("start-dev")]);

      const healthy = yield* polling.poll(instance);
      assert.strictEqual(healthy.failures.length, 0);
      const firstRun = claimedRun(healthy);
      yield* waitForState(engine, firstRun, "Waiting");

      // The item changes while the catalog endpoint is down: the Loop must still fire.
      yield* Ref.set(catalogFails, true);
      yield* Ref.set(hash, ContentHash.make("b".repeat(64)));
      const degraded = yield* polling.poll(instance);
      assert.strictEqual(degraded.changedItems, 2);
      const secondRun = claimedRun(degraded);
      assert.notStrictEqual(secondRun, firstRun);
      yield* waitForState(engine, secondRun, "Waiting");
      assert.deepStrictEqual(
        degraded.failures
          .map(({ repository, errorTag }) => ({ repository, errorTag }))
          .sort((left, right) => left.repository.localeCompare(right.repository)),
        [
          { repository: RepositoryName.make("basaltbytes/unwatched"), errorTag: "GitHubApiError" },
          { repository: watchedRepository, errorTag: "GitHubApiError" },
        ],
      );

      // The stored catalog and its ETag survive the failed request.
      const retained = yield* labels.get(watchedRepository);
      assert(Option.isSome(retained));
      assert.deepStrictEqual(
        retained.value.labels.map(({ name }) => name),
        ["ready"],
      );

      // The next cycle proves both commit points: the item cursor advanced
      // past the degraded poll, and the catalog ETag is still sent.
      const recovered = yield* polling.poll(instance);
      assert.strictEqual(claimedRun(recovered), secondRun);
      const seen = yield* Ref.get(cursorsSeen);
      const returned = yield* Ref.get(cursorsReturned);
      assert.deepStrictEqual(seen[2], Option.some(returned[1]));
      assert.deepStrictEqual(
        (yield* Ref.get(labelEntityTagsSeen))[2],
        Option.some(catalogEntityTag),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "deduplicates snapshots across restart and emits new Events only for new matching content",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = InstanceDirectory.make(
          yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-polling-" }),
        );
        const state = yield* Ref.make<RemoteState>({
          hash: ContentHash.make("a".repeat(64)),
          payload: issuePayload(["ready"]),
        });
        const seenCursors = yield* Ref.make<ReadonlyArray<PollCursor>>([]);
        const seenLabelEntityTags = yield* Ref.make<ReadonlyArray<Option.Option<EntityTag>>>([]);
        const seenRepositories = yield* Ref.make<ReadonlyArray<string>>([]);
        const snapshotCalls = yield* Ref.make(0);
        const changed = new ChangedIssue({
          number: 28,
          updatedAt: DateTime.makeUnsafe("2026-08-30T20:00:00Z"),
        });
        const github: GitHubPolling["Service"] = {
          changes: (repository, cursor) =>
            Effect.gen(function* () {
              yield* Ref.update(seenCursors, (values) => [...values, cursor]);
              yield* Ref.update(seenRepositories, (values) => [...values, repository]);
              return new RepositoryChanges({
                cursor: new PollCursor({
                  entityTag: Option.some(EntityTag.make('W/"live"')),
                  watermark: Option.some(changed.updatedAt),
                }),
                items: [changed],
                backlog: false,
                nextPollAt: Option.none(),
              });
            }),
          labels: (_repository, entityTag) =>
            Effect.gen(function* () {
              yield* Ref.update(seenLabelEntityTags, (values) => [...values, entityTag]);
              if (Option.isSome(entityTag)) return new RepositoryLabelsNotModified();
              return new RepositoryLabelCatalog({
                entityTag: Option.some(EntityTag.make('W/"labels"')),
                labels: [
                  new RepositoryLabel({
                    name: RepositoryLabelName.make("unused-repository-label"),
                    color: RepositoryLabelColor.make("5319E7"),
                    description: Option.some("kept for the restart test"),
                  }),
                ],
              });
            }),
          snapshot: () =>
            Effect.gen(function* () {
              yield* Ref.update(snapshotCalls, (count) => count + 1);
              const current = yield* Ref.get(state);
              return new IssueSnapshot({
                payload: current.payload,
                contentHash: current.hash,
              });
            }),
        };

        const firstInstance = instanceWith([issueLoop("start-dev")]);
        const firstScope = yield* Scope.make();
        const firstContext = yield* Scope.provide(
          Layer.build(runtimeLayer(directory, github)),
          firstScope,
        );
        const firstPolling = Context.get(firstContext, PollingTriggers);
        const firstEngine = Context.get(firstContext, RunEngine);
        const firstCursors = Context.get(firstContext, CursorStore);
        const firstLabels = Context.get(firstContext, RepositoryLabelProjectionReader);

        yield* firstCursors.write(
          CursorKey.make(`github-poll:${watchedRepository}`),
          Schema.Struct({ obsolete: Schema.Boolean }),
          { obsolete: true },
        );

        const coldStart = yield* firstPolling.poll(firstInstance);
        assert.strictEqual(coldStart.repositories, 2);
        assert.strictEqual(coldStart.changedItems, 2);
        const originalRun = claimedRun(coldStart);
        const originalSnapshot = yield* waitForState(firstEngine, originalRun, "Waiting");
        // Ledger rows written before the codec existed must keep matching the
        // keys new polls produce.
        assert.strictEqual(originalSnapshot.itemKey, '["github","basaltbytes/usine",28]');
        assert.strictEqual(originalSnapshot.task, "Implement issue 28.");
        assert.strictEqual(originalSnapshot.agent.name, "developer");
        assert.strictEqual(originalSnapshot.agent.brain.harness, "codex");
        assert.strictEqual(originalSnapshot.agent.brain.model, "gpt-5.6-sol");
        assert.strictEqual(originalSnapshot.agent.brain.effort, "high");
        assert.strictEqual(originalSnapshot.agent.persona, "Implement the issue.");
        const projectedLabels = yield* firstLabels.get(watchedRepository);
        assert(Option.isSome(projectedLabels));
        assert.deepStrictEqual(
          projectedLabels.value.labels.map(({ name }) => name),
          ["unused-repository-label"],
        );
        assert.deepStrictEqual(
          originalSnapshot.parentModel,
          Option.some(ModelId.make("anthropic/instance-parent")),
        );
        const initialCursor = (yield* Ref.get(seenCursors))[0];
        assert(initialCursor !== undefined && Option.isNone(initialCursor.entityTag));

        const duplicate = yield* firstPolling.poll(firstInstance);
        assert.strictEqual(claimedRun(duplicate), originalRun);
        assert.strictEqual((yield* Ref.get(seenLabelEntityTags)).filter(Option.isSome).length, 2);
        yield* Scope.close(firstScope, Exit.void);

        const secondScope = yield* Scope.make();
        const secondContext = yield* Scope.provide(
          Layer.build(runtimeLayer(directory, github)),
          secondScope,
        );
        const secondPolling = Context.get(secondContext, PollingTriggers);
        const secondEngine = Context.get(secondContext, RunEngine);
        const secondLabels = Context.get(secondContext, RepositoryLabelProjectionReader);

        const restoredLabels = yield* secondLabels.get(watchedRepository);
        assert(Option.isSome(restoredLabels));
        assert.deepStrictEqual(
          restoredLabels.value.labels.map(({ name, color, description }) => [
            name,
            Option.getOrNull(color),
            Option.getOrNull(description),
          ]),
          [["unused-repository-label", "5319E7", "kept for the restart test"]],
        );

        const afterRestart = yield* secondPolling.poll(firstInstance);
        assert.strictEqual(claimedRun(afterRestart), originalRun);
        assert.strictEqual((yield* Ref.get(seenLabelEntityTags)).filter(Option.isSome).length, 4);
        const restoredSnapshot = yield* secondEngine.inspect(originalRun);
        assert.strictEqual(restoredSnapshot.task, "Implement issue 28.");
        assert.strictEqual(restoredSnapshot.agent.name, "developer");
        assert.deepStrictEqual(
          restoredSnapshot.parentModel,
          Option.some(ModelId.make("anthropic/instance-parent")),
        );
        const restoredCursors = yield* Ref.get(seenCursors);
        const restartCursor = restoredCursors[2];
        assert(restartCursor !== undefined && Option.isSome(restartCursor.entityTag));

        const expandedInstance = instanceWith([issueLoop("start-dev"), issueLoop("triage-ready")]);
        const newLoopColdStart = yield* secondPolling.poll(expandedInstance);
        assert.strictEqual(newLoopColdStart.submissions.length, 2);
        assert.strictEqual(claimedRun(newLoopColdStart), originalRun);
        const newLoopRun = newLoopColdStart.submissions[1];
        assert(newLoopRun !== undefined && newLoopRun._tag === "Claimed");
        yield* waitForState(secondEngine, newLoopRun.runId, "Waiting");
        assert.strictEqual(
          (yield* Ref.get(seenCursors)).filter(({ entityTag }) => Option.isNone(entityTag)).length,
          3,
        );

        yield* Ref.set(state, {
          hash: ContentHash.make("b".repeat(64)),
          payload: issuePayload(["ready", "touched"]),
        });
        const labelFlip = yield* secondPolling.poll(expandedInstance);
        assert.strictEqual(labelFlip.submissions.length, 2);
        const flippedRun = claimedRun(labelFlip);
        assert.notStrictEqual(flippedRun, originalRun);
        const flippedSnapshot = yield* waitForState(secondEngine, flippedRun, "Waiting");
        assert.deepStrictEqual(flippedSnapshot.event.payload, issuePayload(["ready", "touched"]));

        yield* Ref.set(state, {
          hash: ContentHash.make("c".repeat(64)),
          payload: issuePayload(["done"]),
        });
        const unmatched = yield* secondPolling.poll(expandedInstance);
        assert.strictEqual(unmatched.submissions.length, 0);
        assert.strictEqual(unmatched.revokedRuns, 2);
        const revoked = yield* waitForState(secondEngine, flippedRun, "Canceled");
        assert.strictEqual(revoked.run.state._tag, "Canceled");
        if (revoked.run.state._tag === "Canceled") {
          assert.strictEqual(revoked.run.state.reason._tag, "Revoked");
        }

        const repositories = yield* Ref.get(seenRepositories);
        assert.strictEqual(repositories.filter((name) => name === watchedRepository).length, 6);
        assert.strictEqual(
          repositories.filter((name) => name === "basaltbytes/unwatched").length,
          6,
        );
        assert.strictEqual(yield* Ref.get(snapshotCalls), 12);
        yield* Scope.close(secondScope, Exit.void);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("isolates one repository's failure from its siblings", () => {
    const multiConfig = Schema.decodeUnknownSync(UsineConfig)({
      version: 1,
      repos: [{ name: "basaltbytes/failing" }, { name: "basaltbytes/healthy" }],
      settings: { poll_interval: 60 },
    });
    const loop = new LoopFile({
      name: LoopName.make("watch-open"),
      trigger: new IssueTrigger({ on: "issue", if: Source.make('item.state == "OPEN"') }),
      selector: Option.none(),
      approval: "required",
      step: StepName.make("run"),
      agent: agent.name,
      body: PromptTemplate.make("Implement issue {{ item.number }}."),
    });
    const instance = new LoadedInstance({
      config: multiConfig,
      agents: [agent],
      invalidAgents: [],
      loops: [loop],
      quarantinedLoops: [],
      warnings: [],
    });
    const changed = new ChangedIssue({
      number: 7,
      updatedAt: DateTime.makeUnsafe("2026-08-30T20:00:00Z"),
    });
    const github: GitHubPolling["Service"] = {
      changes: (repository, cursor) =>
        repository === "basaltbytes/failing"
          ? Effect.fail(
              new GitHubApiError({
                operation: "poll-repository-changes",
                status: Option.some(500),
                message: "GitHub rejected the request with status 500",
              }),
            )
          : Effect.succeed(
              new RepositoryChanges({
                cursor,
                items: [changed],
                backlog: false,
                nextPollAt: Option.none(),
              }),
            ),
      labels: () => Effect.succeed(emptyLabelCatalog),
      snapshot: () =>
        Effect.succeed(
          new IssueSnapshot({
            payload: issuePayload([], 7),
            contentHash: ContentHash.make("d".repeat(64)),
          }),
        ),
    };
    const cursors = Layer.succeed(CursorStore)({
      read: () => Effect.succeed(Option.none()),
      write: () => Effect.void,
    });
    const runs = Layer.succeed(RunEngine)({
      resolveFailure: () => Effect.void,
      intervene: () => Effect.void,
      approve: () => Effect.die("unused"),
      cancel: () => Effect.die("unused"),
      discardLeftovers: () => Effect.die("unused"),
      inspect: () => Effect.die("unused"),
      reconcile: () => Effect.die("unused"),
      drain: () => Effect.void,
      retry: () => Effect.die("unused"),
      revoke: () => Effect.succeed([]),
      submit: (submission) =>
        Effect.succeed(
          new Claimed({
            eventId: submission.event.id,
            runId: RunId.make(`run-${submission.event.id}`),
          }),
        ),
      transcript: () => Effect.die("unused"),
    });
    const parser = ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer));
    const layer = PollingTriggers.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          noCycleBudgets,
          cursors,
          itemProjectionWriterLayer,
          repositoryLabelProjectionReaderLayer,
          repositoryLabelProjectionWriterLayer,
          inertGitHubLabelWriterLayer,
          inertLabelReconcilerLayer,
          runs,
          MarcbachmannCelLayer,
          parser,
          Layer.succeed(GitHubPolling, github),
          loopControlLayer(),
        ),
      ),
    );

    return Effect.gen(function* () {
      const polling = yield* PollingTriggers;
      // One repository's typed failure never stops its siblings: the cycle
      // reports the failure and the healthy repository still submits.
      const cycle = yield* polling.poll(instance);
      assert.strictEqual(cycle.repositories, 2);
      assert.strictEqual(cycle.failures.length, 1);
      assert.strictEqual(cycle.failures[0]?.repository, "basaltbytes/failing");
      assert.strictEqual(cycle.failures[0]?.errorTag, "GitHubApiError");
      assert.strictEqual(cycle.submissions.length, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("retains the cursor until every Item's durable Run decision succeeds", () =>
    Effect.gen(function* () {
      const cursors = memoryCursorStore();
      const projections = new Map<number, ItemProjection>();
      const observedCursors: Array<PollCursor> = [];
      const baseline = new PollCursor({
        entityTag: Option.some(EntityTag.make('W/"baseline"')),
        watermark: Option.some(DateTime.makeUnsafe("2026-08-30T19:00:00Z")),
      });
      const advanced = new PollCursor({
        entityTag: Option.some(EntityTag.make('W/"advanced"')),
        watermark: Option.some(DateTime.makeUnsafe("2026-08-30T20:00:00Z")),
      });
      const submitStarted = yield* Deferred.make<void>();
      const revokeStarted = yield* Deferred.make<void>();
      const submitFinished = yield* Deferred.make<void>();
      const allowSubmit = yield* Deferred.make<void>();
      const allowRevoke = yield* Deferred.make<void, EnginePersistenceError>();
      let phase: "baseline" | "interrupted" | "recovered" = "baseline";
      const github: GitHubPolling["Service"] = {
        labels: () => Effect.succeed(emptyLabelCatalog),
        changes: (repository, cursor) =>
          Effect.sync(() => {
            if (repository !== watchedRepository) {
              return new RepositoryNotModified({ cursor, nextPollAt: Option.none() });
            }
            observedCursors.push(cursor);
            return new RepositoryChanges({
              cursor: phase === "baseline" ? baseline : advanced,
              items:
                phase === "baseline"
                  ? []
                  : [28, 29].map(
                      (number) =>
                        new ChangedIssue({
                          number,
                          updatedAt: DateTime.makeUnsafe("2026-08-30T20:00:00Z"),
                        }),
                    ),
              backlog: false,
              nextPollAt: Option.none(),
            });
          }),
        snapshot: (_repository, item) =>
          Effect.succeed(
            new IssueSnapshot({
              payload: issuePayload(item.number === 28 ? ["ready"] : [], item.number),
              contentHash: ContentHash.make("a".repeat(64)),
            }),
          ),
      };
      const runs = Layer.succeed(RunEngine)({
        resolveFailure: () => Effect.void,
        intervene: () => Effect.void,
        approve: () => Effect.die("unused"),
        cancel: () => Effect.die("unused"),
        discardLeftovers: () => Effect.die("unused"),
        inspect: () => Effect.die("unused"),
        reconcile: () => Effect.die("unused"),
        drain: () => Effect.void,
        retry: () => Effect.die("unused"),
        transcript: () => Effect.die("unused"),
        submit: (submission) =>
          Effect.gen(function* () {
            if (phase === "interrupted") {
              yield* Deferred.succeed(submitStarted, undefined);
              yield* Deferred.await(allowSubmit);
              yield* Deferred.succeed(submitFinished, undefined);
            }
            return new Claimed({ eventId: submission.event.id, runId: RunId.make("submitted") });
          }),
        revoke: () =>
          Effect.gen(function* () {
            if (phase === "interrupted") {
              yield* Deferred.succeed(revokeStarted, undefined);
              yield* Deferred.await(allowRevoke);
            }
            return [RunId.make("revoked")];
          }),
      });
      const parser = ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer));
      const layer = PollingTriggers.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            noCycleBudgets,
            Layer.succeed(CursorStore)(cursors.store),
            Layer.succeed(ItemProjectionWriter)({
              upsert: (projection) =>
                Effect.sync(() => {
                  projections.set(projection.number, projection);
                  return true;
                }),
            }),
            repositoryLabelProjectionReaderLayer,
            repositoryLabelProjectionWriterLayer,
            inertLabelReconcilerLayer,
            runs,
            MarcbachmannCelLayer,
            parser,
            Layer.succeed(GitHubPolling, github),
            loopControlLayer(),
          ),
        ),
      );
      const savedCursor = () =>
        Schema.decodeUnknownSync(Schema.Struct({ cursor: PollCursor }))(
          cursors.stored.get(`github-poll:${watchedRepository}`),
        ).cursor;

      yield* Effect.gen(function* () {
        const polling = yield* PollingTriggers;
        const instance = instanceWith([issueLoop("watch-ready")]);
        yield* polling.poll(instance);
        assert.deepStrictEqual(savedCursor(), baseline);

        phase = "interrupted";
        const pending = yield* polling.poll(instance).pipe(Effect.forkChild);
        yield* Deferred.await(submitStarted);
        yield* Deferred.await(revokeStarted);
        assert.deepStrictEqual([...projections.keys()].sort(), [28, 29]);
        assert.deepStrictEqual(savedCursor(), baseline);
        yield* Deferred.succeed(allowSubmit, undefined);
        yield* Deferred.await(submitFinished);
        assert.deepStrictEqual(savedCursor(), baseline);
        yield* Deferred.fail(
          allowRevoke,
          new EnginePersistenceError({
            operation: "revoke Run",
            cause: "storage unavailable",
          }),
        );
        const interrupted = yield* Fiber.join(pending);
        assert.strictEqual(interrupted.failures[0]?.errorTag, "EnginePersistenceError");
        assert.deepStrictEqual(savedCursor(), baseline);

        phase = "recovered";
        const recovered = yield* polling.poll(instance);
        assert.deepStrictEqual(recovered.failures, []);
        assert.strictEqual(recovered.submissions.length, 1);
        assert.strictEqual(recovered.revokedRuns, 1);
        assert.deepStrictEqual(savedCursor(), advanced);
        assert.deepStrictEqual(observedCursors, [PollCursor.empty, baseline, baseline]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("isolates one loop's prompt rendering failure and still advances the cursor", () => {
    // A render failure comes from the loop's authoring and would fail the same
    // way on re-poll, so it must not wedge the repository.
    const broken = issueLoop("broken-prompt");
    const healthy = issueLoop("healthy-prompt");
    const cursorWrites: Array<CursorKey> = [];
    const cursors = Layer.succeed(CursorStore)({
      read: () => Effect.succeed(Option.none()),
      write: (key) =>
        Effect.sync(() => {
          cursorWrites.push(key);
        }),
    });
    const runs = Layer.succeed(RunEngine)({
      resolveFailure: () => Effect.void,
      intervene: () => Effect.void,
      approve: () => Effect.die("unused"),
      cancel: () => Effect.die("unused"),
      discardLeftovers: () => Effect.die("unused"),
      inspect: () => Effect.die("unused"),
      reconcile: () => Effect.die("unused"),
      drain: () => Effect.void,
      retry: () => Effect.die("unused"),
      revoke: () => Effect.succeed([]),
      submit: (submission) =>
        Effect.succeed(
          new Claimed({
            eventId: submission.event.id,
            runId: RunId.make(`run-${submission.loop}`),
          }),
        ),
      transcript: () => Effect.die("unused"),
    });
    const parser = Layer.succeed(ConfigParser)({
      configWarnings: () => Effect.die("unused"),
      parseAgentFile: () => Effect.die("unused"),
      parseLoopFile: () => Effect.die("unused"),
      parseUsineYaml: () => Effect.die("unused"),
      renderPrompt: (loop) =>
        loop.name === broken.name
          ? Effect.fail(
              new ConfigFileError({
                file: InstancePath.make(`loops/${loop.name}.md`),
                stage: "expression",
                expression: Option.some(Source.make("item.missing")),
                message: "No such key: missing",
              }),
            )
          : Effect.succeed(`Rendered ${loop.name}.`),
    });
    const github: GitHubPolling["Service"] = {
      changes: (_repository, cursor) =>
        Effect.succeed(
          new RepositoryChanges({
            cursor,
            items: [
              new ChangedIssue({
                number: 28,
                updatedAt: DateTime.makeUnsafe("2026-08-30T20:00:00Z"),
              }),
            ],
            backlog: false,
            nextPollAt: Option.none(),
          }),
        ),
      labels: () => Effect.succeed(emptyLabelCatalog),
      snapshot: () =>
        Effect.succeed(
          new IssueSnapshot({
            payload: issuePayload(["ready"]),
            contentHash: ContentHash.make("c".repeat(64)),
          }),
        ),
    };
    const layer = PollingTriggers.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          noCycleBudgets,
          cursors,
          itemProjectionWriterLayer,
          repositoryLabelProjectionReaderLayer,
          repositoryLabelProjectionWriterLayer,
          inertGitHubLabelWriterLayer,
          inertLabelReconcilerLayer,
          runs,
          MarcbachmannCelLayer,
          parser,
          Layer.succeed(GitHubPolling, github),
          loopControlLayer(),
        ),
      ),
    );

    return Effect.gen(function* () {
      const polling = yield* PollingTriggers;
      const cycle = yield* polling.poll(instanceWith([broken, healthy]));
      assert.strictEqual(cycle.failures.length, 1);
      assert.strictEqual(cycle.failures[0]?.repository, watchedRepository);
      assert.strictEqual(cycle.failures[0]?.errorTag, "ConfigFileError");
      assert.strictEqual(cycle.submissions.length, 1);
      assert.strictEqual(cycle.submissions[0]?._tag, "Claimed");
      assert.strictEqual(cursorWrites.length, 2);
    }).pipe(Effect.provide(layer));
  });

  it.live("submits items from concurrent repositories through one engine", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-polling-multi-" }),
      );
      const multiConfig = Schema.decodeUnknownSync(UsineConfig)({
        version: 1,
        repos: [{ name: "basaltbytes/one" }, { name: "basaltbytes/two" }],
        settings: { poll_interval: 60 },
      });
      const loop = new LoopFile({
        name: LoopName.make("watch-open"),
        trigger: new IssueTrigger({ on: "issue", if: Source.make('item.state == "OPEN"') }),
        selector: Option.none(),
        approval: "required",
        step: StepName.make("run"),
        agent: agent.name,
        body: PromptTemplate.make("Implement issue {{ item.number }}."),
      });
      const instance = new LoadedInstance({
        config: multiConfig,
        agents: [agent],
        invalidAgents: [],
        loops: [loop],
        quarantinedLoops: [],
        warnings: [],
      });
      const changedItems = [11, 12].map(
        (number) =>
          new ChangedIssue({ number, updatedAt: DateTime.makeUnsafe("2026-08-30T20:00:00Z") }),
      );
      const hashFor = (repository: string, number: number) =>
        ContentHash.make(
          `${(repository.endsWith("one") ? "a" : "b").repeat(32)}${String(number).repeat(16)}`,
        );
      const github: GitHubPolling["Service"] = {
        changes: (_repository, cursor) =>
          Effect.succeed(
            new RepositoryChanges({
              cursor,
              items: changedItems,
              backlog: false,
              nextPollAt: Option.none(),
            }),
          ),
        labels: () => Effect.succeed(emptyLabelCatalog),
        snapshot: (repository, item) =>
          Effect.succeed(
            new IssueSnapshot({
              payload: issuePayload([], item.number),
              contentHash: hashFor(repository, item.number),
            }),
          ),
      };

      // Four concurrent submissions across two repositories all land on one
      // SQLite engine: distinct runs, no lost or interleaved writes.
      yield* Effect.gen(function* () {
        const polling = yield* PollingTriggers;
        const engine = yield* RunEngine;
        const cycle = yield* polling.poll(instance);
        assert.strictEqual(cycle.repositories, 2);
        assert.strictEqual(cycle.changedItems, 4);
        assert.strictEqual(cycle.failures.length, 0);
        assert.strictEqual(cycle.submissions.length, 4);
        const runIds = cycle.submissions.flatMap((submission) =>
          submission._tag === "Claimed" ? [submission.runId] : [],
        );
        assert.strictEqual(new Set(runIds).size, 4);
        for (const runId of runIds) {
          yield* waitForState(engine, runId, "Waiting");
        }
      }).pipe(Effect.provide(runtimeLayer(directory, github)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.live("opens the next Run with a reloaded Agent while the open Run keeps its own", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-reload-agent-" }),
      );
      const agentFile = (model: string) =>
        `---\nharness: codex\nmodel: ${model}\neffort: high\n---\nImplement the issue.\n`;
      yield* writeInstanceFiles(directory, [
        ["usine.yaml", `version: 1\nrepos:\n  - name: ${watchedRepository}\n`],
        ["agents/developer.md", agentFile("gpt-5.6-sol")],
        [
          "loops/start-dev.md",
          '---\ntrigger:\n  on: issue\n  if: item.labels.nodes.exists(label, label.name == "ready")\napproval: required\nstep: implement\nagent: developer\n---\nImplement issue {{ item.number }}.\n',
        ],
      ]);
      const open = new Set([28]);
      const updatedAt = DateTime.makeUnsafe("2026-08-30T20:00:00Z");
      const github: GitHubPolling["Service"] = {
        labels: () => Effect.succeed(emptyLabelCatalog),
        changes: (_repository, cursor) =>
          Effect.succeed(
            new RepositoryChanges({
              cursor,
              items: [...open].map((number) => new ChangedIssue({ number, updatedAt })),
              backlog: false,
              nextPollAt: Option.none(),
            }),
          ),
        snapshot: (_repository, item) =>
          Effect.succeed(
            new IssueSnapshot({
              payload: issuePayload(["ready"], item.number),
              contentHash: ContentHash.make((item.number === 28 ? "a" : "b").repeat(64)),
            }),
          ),
      };
      const models: Array<string> = [];
      const executor = Layer.succeed(StepExecutor)({
        workers: [WorkerName.make("local")],
        isLive: () => Effect.succeed(false),
        outcome: () => Effect.succeed(Option.none()),
        recover: () => Effect.void,
        intervene: () => Effect.void,
        interrupt: () => Effect.void,
        reserve: () => Effect.succeed({ worker: WorkerName.make("local"), release: Effect.void }),
        execute: (execution) =>
          Effect.sync(() => {
            models.push(execution.agent.brain.model);
            return new StepResult({ message: "Implemented", facts: [] });
          }),
      });

      yield* Effect.gen(function* () {
        const polling = yield* PollingTriggers;
        const engine = yield* RunEngine;
        const instances = yield* CurrentInstance;
        const openRun = claimedRun(yield* polling.poll(yield* instances.get));
        yield* waitForState(engine, openRun, "Waiting");

        yield* writeInstanceFiles(directory, [["agents/developer.md", agentFile("gpt-5.7-sol")]]);
        const reload = yield* instances.reload;
        assert.deepStrictEqual(reload.agents.changed, [agent.name]);

        open.add(29);
        const second = yield* polling.poll(yield* instances.get);
        const nextRun = second.submissions.flatMap((submission) =>
          submission._tag === "Claimed" && submission.runId !== openRun ? [submission.runId] : [],
        )[0];
        assert(nextRun !== undefined, "issue 29 opens a Run");
        assert.strictEqual((yield* engine.inspect(nextRun)).agent.brain.model, "gpt-5.7-sol");
        assert.strictEqual((yield* engine.inspect(openRun)).agent.brain.model, "gpt-5.6-sol");

        const dedupKey = DedupKey.make(JSON.stringify(["operator-approval", openRun]));
        yield* engine.approve(
          openRun,
          new Event({ id: EventId.make(dedupKey), dedupKey, payload: {}, receivedAt: updatedAt }),
        );
        yield* waitForState(engine, openRun, "Succeeded");
        assert.deepStrictEqual(models, ["gpt-5.6-sol"]);
      }).pipe(
        Effect.provide(
          Layer.merge(
            runtimeLayer(directory, github, executor),
            reloadableInstanceLayer(directory),
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
