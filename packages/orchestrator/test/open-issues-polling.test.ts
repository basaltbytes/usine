import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
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
import type { RunId } from "@usine/core/run";
import { StepName } from "@usine/core/step";
import { WorkerName } from "@usine/core/worker";
import { RunEngine } from "@usine/engine/engine";
import { ItemProjectionReader } from "@usine/engine/item-projection";
import { layer as localEngineLayer } from "@usine/engine/local-sqlite";
import { StepExecutor } from "@usine/engine/step-executor";
import { Source } from "@usine/expression/expression-engine";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { GitHubApiError } from "@usine/github/github-app";
import {
  ChangedIssue,
  ContentHash,
  EntityTag,
  GitHubPolling,
  IssueSnapshot,
  PollCursor,
  RepositoryChanges,
  RepositoryLabelCatalog,
  RepositoryNotModified,
} from "@usine/github/polling";
import { DateTime, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { projectBoard } from "../src/board/projection.ts";
import { PollingTriggers } from "../src/polling-triggers.ts";
import {
  alwaysHoldsLayer,
  inertLabelReconcilerLayer,
  pollingTestLayer,
  unmovedBaseRefHead,
} from "./support/polling.ts";

const repository = RepositoryName.make("basaltbytes/usine");
const config = Schema.decodeUnknownSync(UsineConfig)({
  version: 1,
  repos: [
    {
      name: repository,
      lanes: [
        { name: "Open", sources: [{ state: "issue-open" }] },
        { name: "Closed", sources: [{ state: "issue-closed" }] },
      ],
    },
  ],
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
const loop = new LoopFile({
  name: LoopName.make("start-dev"),
  trigger: new IssueTrigger({ on: "issue", if: Source.make('item.state == "OPEN"') }),
  selector: Option.none(),
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
const emptyCatalog = new RepositoryLabelCatalog({ entityTag: Option.none(), labels: [] });
const issue28 = new IssueSnapshot({
  contentHash: ContentHash.make("a".repeat(64)),
  payload: {
    number: 28,
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
    labels: { totalCount: 0, nodes: [] },
    assignees: { totalCount: 0, nodes: [] },
    comments: { totalCount: 0, nodes: [] },
    closedByPullRequestsReferences: { totalCount: 0, nodes: [] },
  },
});

const gatedExecutor = Layer.succeed(StepExecutor)({
  workers: Effect.succeed([WorkerName.make("local")]),
  isLive: () => Effect.succeed(false),
  outcome: () => Effect.succeed(Option.none()),
  recover: () => Effect.void,
  intervene: () => Effect.void,
  interrupt: () => Effect.void,
  occupy: (worker) => Effect.succeed({ worker, release: Effect.void }),
  sweep: Effect.void,
  discard: () => Effect.void,
  reserve: () => Effect.die("an approval-gated test run must not reserve a worker"),
  execute: () => Effect.die("an approval-gated test run must not start an Attempt"),
});

/** One `usine up` process over the instance database in `directory`. */
const processLayer = (directory: InstanceDirectory, github: GitHubPolling["Service"]) => {
  const dependencies = Layer.mergeAll(
    localEngineLayer(directory).pipe(Layer.provide(gatedExecutor), Layer.provide(alwaysHoldsLayer)),
    MarcbachmannCelLayer,
    ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer)),
    inertLabelReconcilerLayer,
    Layer.succeed(GitHubPolling, github),
  );
  return Layer.merge(dependencies, PollingTriggers.layer.pipe(Layer.provide(dependencies)));
};

const waitForState = Effect.fn("test.waitForState")(function* (
  runId: RunId,
  tag: "Canceled" | "Waiting",
) {
  const engine = yield* RunEngine;
  for (let poll = 0; poll < 500; poll += 1) {
    const snapshot = yield* engine.inspect(runId);
    if (snapshot.run.state._tag === tag) return snapshot;
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die(`Run ${runId} did not reach ${tag}`);
});

describe("PollingTriggers open-issue check", () => {
  it.live(
    "marks an open issue GitHub no longer has as gone and moves its card out of the open lanes",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = InstanceDirectory.make(
          yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-open-issues-" }),
        );
        const instance = instanceWith([loop]);
        let deleted = false;
        const asked: Array<ReadonlyArray<number>> = [];
        const github: GitHubPolling["Service"] = {
          labels: () => Effect.succeed(emptyCatalog),
          changes: (_, cursor) =>
            Effect.succeed(
              Option.isNone(cursor.entityTag)
                ? new RepositoryChanges({
                    cursor: new PollCursor({
                      entityTag: Option.some(EntityTag.make('W/"unchanged"')),
                      watermark: Option.some(DateTime.makeUnsafe("2026-08-30T20:00:00Z")),
                    }),
                    items: [
                      new ChangedIssue({
                        number: 28,
                        updatedAt: DateTime.makeUnsafe("2026-08-30T20:00:00Z"),
                      }),
                    ],
                    backlog: false,
                    nextPollAt: Option.none(),
                  })
                : new RepositoryNotModified({ cursor, nextPollAt: Option.none() }),
            ),
          snapshot: () => Effect.succeed(issue28),
          baseRefHead: unmovedBaseRefHead,
          missingIssues: (_, numbers) =>
            Effect.sync(() => {
              asked.push(numbers);
              return deleted ? numbers : [];
            }),
        };

        const runId = yield* Effect.gen(function* () {
          const polling = yield* PollingTriggers;
          const cycle = yield* polling.poll(instance);
          const submission = cycle.submissions[0];
          assert(submission?._tag === "Claimed");
          yield* waitForState(submission.runId, "Waiting");
          return submission.runId;
        }).pipe(Effect.provide(processLayer(directory, github)));
        assert.deepStrictEqual(asked, [[28]]);

        // Change detection never lists a deleted issue again; the next process
        // checks the open issue on its first cycle.
        deleted = true;
        yield* Effect.gen(function* () {
          const polling = yield* PollingTriggers;
          const items = yield* ItemProjectionReader;
          const cycle = yield* polling.poll(instance);
          assert.deepStrictEqual(cycle.failures, []);
          assert.strictEqual(cycle.changedItems, 0);
          assert.strictEqual(cycle.revokedRuns, 1);
          const revoked = yield* waitForState(runId, "Canceled");
          assert(revoked.run.state._tag === "Canceled");
          assert.strictEqual(revoked.run.state.reason._tag, "Revoked");

          const stored = yield* items.list(repository, { limit: 10 });
          assert(stored[0] !== undefined && Option.isSome(stored[0].goneAt));
          const managed = config.repos[0];
          assert(managed !== undefined);
          const board = yield* projectBoard(managed, [], stored, []);
          assert.deepStrictEqual(board.lanes[0]?.items, []);
          assert.strictEqual(board.lanes[1]?.items[0]?.state, "issue-closed");
          assert.deepStrictEqual(yield* items.openIssues(repository), []);
        }).pipe(Effect.provide(processLayer(directory, github)));
        assert.deepStrictEqual(asked, [[28], [28]]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "checks a repository's open issues at most once every 10 minutes, a failed check included",
    () => {
      const instance = instanceWith([]);
      let requests = 0;
      const github: GitHubPolling["Service"] = {
        labels: () => Effect.succeed(emptyCatalog),
        changes: (_, cursor) =>
          Effect.succeed(new RepositoryNotModified({ cursor, nextPollAt: Option.none() })),
        snapshot: () => Effect.die("no Item changed"),
        baseRefHead: unmovedBaseRefHead,
        missingIssues: () =>
          Effect.suspend(() => {
            requests += 1;
            return requests === 1
              ? Effect.fail(
                  new GitHubApiError({
                    operation: "find-missing-issues",
                    status: Option.some(502),
                    message: "GitHub returned HTTP status 502",
                  }),
                )
              : Effect.succeed([]);
          }),
      };
      const items: ItemProjectionReader["Service"] = {
        get: () => Effect.succeed(Option.none()),
        list: () => Effect.die("the poll does not list projections"),
        openIssues: () => Effect.succeed([ItemNumber.make(28)]),
      };

      return Effect.gen(function* () {
        const polling = yield* PollingTriggers;
        const failed = yield* polling.poll(instance);
        assert.strictEqual(requests, 1);
        assert.deepStrictEqual(
          failed.failures.map(({ errorTag }) => errorTag),
          ["GitHubApiError"],
        );

        yield* TestClock.adjust("9 minutes");
        const skipped = yield* polling.poll(instance);
        assert.strictEqual(requests, 1);
        assert.deepStrictEqual(skipped.failures, []);

        yield* TestClock.adjust("1 minute");
        const checked = yield* polling.poll(instance);
        assert.strictEqual(requests, 2);
        assert.deepStrictEqual(checked.failures, []);
      }).pipe(
        Effect.provide(
          pollingTestLayer(github, [], undefined, undefined, undefined, undefined, items),
        ),
      );
    },
  );
});
