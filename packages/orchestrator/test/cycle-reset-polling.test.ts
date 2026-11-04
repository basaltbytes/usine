import { jsonKey } from "@usine/core/json-key";
import { idleCiMonitor } from "./support/ci.ts";
import { sqliteTempDirectory } from "../../../tooling/test/sqlite.mts";
import { NodeServices } from "@effect/platform-node";
import { AgentFile } from "@usine/config/agent";
import { InstancePath } from "@usine/config/file";
import { LoopFile } from "@usine/config/loop";
import { ConfigParser } from "@usine/config/parser";
import { Event, EventId, DedupKey } from "@usine/core/event";
import { InstanceDirectory } from "@usine/core/instance";
import type { CycleBudgetAsk } from "@usine/core/cycle-budget";
import { LoopName } from "@usine/core/loop";
import { StepCompletion, StepResult } from "@usine/core/step/result";
import { WorkerName } from "@usine/core/worker";
import { RunEngine } from "@usine/engine/engine";
import { StepExecutor } from "@usine/engine/step-executor";
import { layer as localEngineLayer } from "@usine/engine/local-sqlite";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { ChangedIssue, ContentHash, IssueSnapshot, type IssuePayload } from "@usine/github/polling";
import { Effect, Deferred, Fiber, FileSystem, Layer, Schema, DateTime, Option } from "effect";
import { alwaysHoldsLayer, inertLabelReconcilerLayer } from "./support/polling.ts";
import { assert, describe, it } from "@effect/vitest";
import { UsineConfig } from "@usine/config/factory";
import { LoadedInstance } from "@usine/config/instance";
import { ItemKey, ItemNumber } from "@usine/core/item";
import { RepositoryName } from "@usine/core/repository";
import { CycleBudgetReset, CycleBudgets } from "@usine/engine/cycle-budget";
import { AttentionAcknowledgement, AttentionAcknowledgements } from "@usine/engine/attention";
import { GitHubApiError } from "@usine/github/github-app";
import {
  ItemContentHash,
  ItemProjection,
  ItemProjectionSource,
} from "@usine/engine/item-projection";
import {
  EntityTag,
  GitHubPolling,
  PollCursor,
  RepositoryChanges,
  RepositoryLabelCatalog,
  RepositoryNotModified,
} from "@usine/github/polling";

import { PollingTriggers } from "../src/polling-triggers.ts";
import { attentionKey, partitionNeeds } from "../src/operator/attention.ts";
import { CycleBudgetNeed } from "../src/operator/need.ts";
import {
  emptyCycleBudgets,
  memoryCursorStore,
  pollingTestLayer,
  unmovedBaseRefHead,
} from "./support/polling.ts";

const repository = RepositoryName.make("basaltbytes/usine");
const instance = Effect.gen(function* () {
  const decodedValue1 = yield* Schema.decodeEffect(UsineConfig)({
    version: 1,
    repos: [{ name: repository }],
  });
  return LoadedInstance.make({
    config: decodedValue1,
    agents: [],
    invalidAgents: [],
    loops: [],
    quarantinedLoops: [],
    warnings: [],
  });
});

const issuePayload = (number: number, labels: ReadonlyArray<string> = []): IssuePayload => ({
  number,
  title: "Review reset",
  body: "Review the Item.",
  url: `https://github.com/basaltbytes/usine/issues/${number}`,
  state: "OPEN",
  stateReason: null,
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-05T00:00:00Z",
  closedAt: null,
  author: { login: "operator" },
  issueType: null,
  milestone: null,
  labelEvents: {},
  labels: { totalCount: labels.length, nodes: labels.map((name) => ({ name })) },
  assignees: { totalCount: 0, nodes: [] },
  comments: { totalCount: 0, nodes: [] },
  closedByPullRequestsReferences: { totalCount: 0, nodes: [] },
});

const storedIssue = (number: number) =>
  ItemProjection.make({
    itemKey: ItemKey.make(jsonKey(["github", repository, number])),
    repository,
    source: ItemProjectionSource.make("issue"),
    number: ItemNumber.make(number),
    contentHash: ItemContentHash.make("a".repeat(64)),
    payload: issuePayload(number),
  });

const storedCursor = PollCursor.make({
  entityTag: Option.some(EntityTag.make('"stored"')),
  watermark: Option.some(DateTime.makeUnsafe("2026-09-05T00:00:00Z")),
});

describe("cycle reset polling", () => {
  it.effect(
    "restarts cursors after a reset of an Item polling never stored, retains failed refreshes, and continues a committed backlog",
    () => {
      const cursors = memoryCursorStore();
      const fresh = PollCursor.make({
        entityTag: Option.some(EntityTag.make('"fresh"')),
        watermark: Option.some(DateTime.makeUnsafe("2026-09-05T00:00:00Z")),
      });

      let pending: ReadonlyArray<CycleBudgetReset> = [];
      let fails = false;
      const seen: Array<PollCursor> = [];
      const acknowledgements: Array<CycleBudgetReset> = [];
      const budgets: CycleBudgets["Service"] = {
        ...emptyCycleBudgets,
        pendingResets: Effect.sync(() => pending),
        acknowledgeReset: (value) =>
          Effect.sync(() => {
            // Cursor progress must already be durable when the reset is acknowledged.
            assert(cursors.stored.size > 0);
            acknowledgements.push(value);
            pending = [];
          }),
      };
      const github: GitHubPolling["Service"] = {
        baseRefHead: unmovedBaseRefHead,
        missingIssues: () => Effect.succeed([]),
        labels: () =>
          Effect.succeed(RepositoryLabelCatalog.make({ labels: [], entityTag: Option.none() })),
        snapshot: () => Effect.die("no Items on this page"),
        changes: (_repository, cursor) =>
          Effect.gen(function* () {
            seen.push(cursor);
            if (fails)
              return yield* GitHubApiError.make({
                operation: "poll-repository-changes",
                status: Option.some(503),
                message: "unavailable",
              });
            return RepositoryChanges.make({
              cursor: fresh,
              items: [],
              backlog: true,
              nextPollAt: Option.none(),
            });
          }),
      };
      return Effect.gen(function* () {
        const reset = yield* Schema.decodeEffect(CycleBudgetReset)({
          itemKey: ItemKey.make("pr-72"),
          repository,
          generation: 1,
        });
        const fixtureInstance = yield* instance;
        const polling = yield* PollingTriggers;

        yield* polling.poll(fixtureInstance);

        yield* polling.poll(fixtureInstance);
        assert.deepStrictEqual(seen[1], fresh);
        pending = [reset];
        fails = true;

        const decodedValue2 = yield* polling.poll(fixtureInstance);
        assert.deepStrictEqual(decodedValue2.failures, []);
        assert.deepStrictEqual(seen[2], PollCursor.empty);
        assert.deepStrictEqual(pending, [reset]);
        assert.deepStrictEqual(acknowledgements, []);
        fails = false;

        yield* polling.poll(fixtureInstance);
        assert.deepStrictEqual(seen[3], PollCursor.empty);
        assert.deepStrictEqual(acknowledgements, [reset]);

        yield* polling.poll(fixtureInstance);
        assert.deepStrictEqual(seen[4], fresh);
      }).pipe(
        Effect.provide(pollingTestLayer(github, [], undefined, undefined, cursors.store, budgets)),
      );
    },
  );

  it.effect("refreshes only the reset Item and normal changes, keeping the stored cursor", () => {
    const cursors = memoryCursorStore();

    let pending: ReadonlyArray<CycleBudgetReset> = [];
    let changed: ReadonlyArray<number> = [];
    const seen: Array<PollCursor> = [];
    const fetched: Array<number> = [];
    const acknowledgements: Array<CycleBudgetReset> = [];
    const budgets: CycleBudgets["Service"] = {
      ...emptyCycleBudgets,
      pendingResets: Effect.sync(() => pending),
      acknowledgeReset: (value) =>
        Effect.sync(() => {
          acknowledgements.push(value);
          pending = [];
        }),
    };
    const github: GitHubPolling["Service"] = {
      baseRefHead: unmovedBaseRefHead,
      missingIssues: () => Effect.succeed([]),
      labels: () =>
        Effect.succeed(RepositoryLabelCatalog.make({ labels: [], entityTag: Option.none() })),
      snapshot: (_repository, item) =>
        Effect.sync(() => {
          fetched.push(item.number);
          return IssueSnapshot.make({
            payload: issuePayload(item.number),
            contentHash: ContentHash.make("b".repeat(64)),
          });
        }),
      changes: (_repository, cursor) =>
        Effect.sync(() => {
          seen.push(cursor);
          return changed.length === 0
            ? RepositoryNotModified.make({ cursor, nextPollAt: Option.none() })
            : RepositoryChanges.make({
                cursor: storedCursor,
                items: changed.map((number) =>
                  ChangedIssue.make({
                    number,
                    updatedAt: DateTime.makeUnsafe("2026-09-05T00:00:00Z"),
                  }),
                ),
                backlog: false,
                nextPollAt: Option.none(),
              });
        }),
    };
    return Effect.gen(function* () {
      const reset = yield* Schema.decodeEffect(CycleBudgetReset)({
        itemKey: storedIssue(72).itemKey,
        repository,
        generation: 1,
      });
      const fixtureInstance = yield* instance;
      const polling = yield* PollingTriggers;
      changed = [80, 81];

      yield* polling.poll(fixtureInstance);
      assert.deepStrictEqual(fetched, [80, 81]);

      pending = [reset];
      changed = [81];
      fetched.length = 0;

      const cycle = yield* polling.poll(fixtureInstance);
      assert.deepStrictEqual(cycle.failures, []);
      assert.deepStrictEqual(seen[1], storedCursor);
      assert.deepStrictEqual(
        [...fetched].sort((left, right) => left - right),
        [72, 81],
      );
      assert.deepStrictEqual(acknowledgements, [reset]);

      changed = [];
      fetched.length = 0;

      yield* polling.poll(fixtureInstance);
      assert.deepStrictEqual(seen[2], storedCursor);
      assert.deepStrictEqual(fetched, []);
    }).pipe(
      Effect.provide(
        pollingTestLayer(github, [], undefined, undefined, cursors.store, budgets, {
          get: (itemKey) =>
            Effect.succeed(
              itemKey === storedIssue(72).itemKey ? Option.some(storedIssue(72)) : Option.none(),
            ),
          list: () => Effect.succeed([]),
          openIssues: () => Effect.succeed([]),
        }),
      ),
    );
  });

  it.effect("keeps a reset pending while GitHub returns a server error for its Item", () => {
    const cursors = memoryCursorStore();

    let pending: ReadonlyArray<CycleBudgetReset> = [];
    let unavailable = true;
    const fetched: Array<number> = [];
    const acknowledgements: Array<CycleBudgetReset> = [];
    const budgets: CycleBudgets["Service"] = {
      ...emptyCycleBudgets,
      pendingResets: Effect.sync(() => pending),
      acknowledgeReset: (value) =>
        Effect.sync(() => {
          acknowledgements.push(value);
          pending = [];
        }),
    };
    const github: GitHubPolling["Service"] = {
      baseRefHead: unmovedBaseRefHead,
      missingIssues: () => Effect.succeed([]),
      labels: () =>
        Effect.succeed(RepositoryLabelCatalog.make({ labels: [], entityTag: Option.none() })),
      snapshot: (_repository, item) =>
        Effect.gen(function* () {
          fetched.push(item.number);
          if (unavailable)
            return yield* GitHubApiError.make({
              operation: "fetch-issue-snapshot",
              status: Option.some(504),
              message: "GitHub returned HTTP status 504",
            });
          return IssueSnapshot.make({
            payload: issuePayload(item.number),
            contentHash: ContentHash.make("b".repeat(64)),
          });
        }),
      changes: (_repository, cursor) =>
        Effect.succeed(RepositoryNotModified.make({ cursor, nextPollAt: Option.none() })),
    };
    return Effect.gen(function* () {
      const reset = yield* Schema.decodeEffect(CycleBudgetReset)({
        itemKey: storedIssue(72).itemKey,
        repository,
        generation: 1,
      });
      pending = [reset];
      const fixtureInstance = yield* instance;
      const polling = yield* PollingTriggers;

      const failed = yield* polling.poll(fixtureInstance);
      assert.deepStrictEqual(failed.failures, []);
      assert.deepStrictEqual(fetched, [72]);
      assert.deepStrictEqual(acknowledgements, []);
      assert(cursors.stored.size > 0);

      unavailable = false;

      yield* polling.poll(fixtureInstance);
      assert.deepStrictEqual(fetched, [72, 72]);
      assert.deepStrictEqual(acknowledgements, [reset]);

      yield* polling.poll(fixtureInstance);
      assert.deepStrictEqual(fetched, [72, 72]);
    }).pipe(
      Effect.provide(
        pollingTestLayer(github, [], undefined, undefined, cursors.store, budgets, {
          get: (itemKey) =>
            Effect.succeed(
              itemKey === storedIssue(72).itemKey ? Option.some(storedIssue(72)) : Option.none(),
            ),
          list: () => Effect.succeed([]),
          openIssues: () => Effect.succeed([]),
        }),
      ),
    );
  });
});

it.live(
  "refreshes dismissed cycle blocks and discards pre-reset polling with current configuration afterward",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const currentDirectory = yield* fs.makeTempDirectoryScoped({
        directory: sqliteTempDirectory(),
        prefix: "usine-reset-race-",
      });
      const directory = InstanceDirectory.make(currentDirectory);
      const parser = yield* ConfigParser;
      const makeLoop = (body: string, approval: "none" | "required") =>
        parser.parseLoopFile(
          InstancePath.make("loops/review.md"),
          `---\ntrigger:\n  on: issue\n  if: 'item.labels.nodes.exists(l, l.name == "ready")'\nmax_cycles: 1\napproval: ${approval}\nagent: reviewer\n---\n${body}`,
        );
      const loop = yield* makeLoop("Original task {{ item.number }}.", "none");
      const agent = yield* Schema.decodeEffect(AgentFile)({
        name: "reviewer",
        harness: "codex",
        model: "test-model",
        effort: "high",
        parentModel: Option.none(),
        parentEffort: Option.none(),
        persona: "Review this Item.",
      });
      const withLoop = (loop: LoopFile) =>
        Effect.gen(function* () {
          return LoadedInstance.make({ ...(yield* instance), agents: [agent], loops: [loop] });
        });
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let shouldPause = false;
      let ready = true;
      let hash = "a";
      const controlledParser = Layer.succeed(ConfigParser)({
        ...parser,
        renderPrompt: (loop, context) =>
          Effect.gen(function* () {
            const task = yield* parser.renderPrompt(loop, context);
            if (shouldPause) {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
            return task;
          }),
      });
      const payload = (): IssuePayload => ({
        number: 72,
        title: "Review reset",
        body: "Review the Item.",
        url: "https://github.com/basaltbytes/usine/issues/72",
        state: "OPEN",
        stateReason: null,
        createdAt: "2026-09-01T00:00:00Z",
        updatedAt: "2026-09-05T00:00:00Z",
        closedAt: null,
        author: { login: "operator" },
        issueType: null,
        milestone: null,
        labelEvents: {},
        labels: { totalCount: ready ? 1 : 0, nodes: ready ? [{ name: "ready" }] : [] },
        assignees: { totalCount: 0, nodes: [] },
        comments: { totalCount: 0, nodes: [] },
        closedByPullRequestsReferences: { totalCount: 0, nodes: [] },
      });
      const github: GitHubPolling["Service"] = {
        baseRefHead: unmovedBaseRefHead,
        missingIssues: () => Effect.succeed([]),
        labels: () =>
          Effect.succeed(RepositoryLabelCatalog.make({ labels: [], entityTag: Option.none() })),
        changes: () =>
          Effect.succeed(
            RepositoryChanges.make({
              cursor: PollCursor.empty,
              items: [
                ChangedIssue.make({
                  number: 72,
                  updatedAt: DateTime.makeUnsafe("2026-09-05T00:00:00Z"),
                }),
              ],
              backlog: false,
              nextPollAt: Option.none(),
            }),
          ),
        snapshot: () =>
          Effect.sync(() =>
            IssueSnapshot.make({
              payload: payload(),
              contentHash: ContentHash.make(hash.repeat(64)),
            }),
          ),
      };
      const executor = Layer.succeed(StepExecutor)({
        workers: Effect.succeed([WorkerName.make("local")]),
        isLive: () => Effect.succeed(false),
        outcome: () => Effect.succeedNone,
        recover: () => Effect.void,
        intervene: () => Effect.void,
        occupy: (worker) => Effect.succeed({ worker, release: Effect.void }),
        sweep: Effect.void,
        discard: () => Effect.void,
        reserve: () => Effect.succeed({ worker: WorkerName.make("test"), release: Effect.void }),
        interrupt: () => Effect.void,
        execute: () =>
          Effect.succeed(
            StepCompletion.fromResult(StepResult.make({ message: "Reviewed", facts: [] })),
          ),
      });
      const engineLayer = localEngineLayer(directory).pipe(
        Layer.provide(executor),
        Layer.provide(alwaysHoldsLayer),
      );
      const dependencies = Layer.mergeAll(
        engineLayer,
        controlledParser,
        MarcbachmannCelLayer,
        inertLabelReconcilerLayer,
        Layer.succeed(GitHubPolling)(github),
      );
      const runtime = Layer.merge(
        dependencies,
        PollingTriggers.layer.pipe(Layer.provide(idleCiMonitor), Layer.provide(dependencies)),
      );
      yield* Effect.gen(function* () {
        const polling = yield* PollingTriggers;
        const engine = yield* RunEngine;
        const budgets = yield* CycleBudgets;
        const decodedValue10 = yield* withLoop(loop);
        const initial = yield* polling.poll(decodedValue10);
        const first = initial.submissions[0];
        assert(first?._tag === "Claimed");
        for (let attempt = 0; attempt < 500; attempt += 1) {
          if ((yield* engine.inspect(first.runId)).run.state._tag === "Succeeded") break;
          yield* Effect.sleep("10 millis");
        }

        assert.strictEqual((yield* engine.inspect(first.runId)).run.state._tag, "Succeeded");
        hash = "b";
        const decodedValue9 = yield* withLoop(loop);
        const exhausted = yield* polling.poll(decodedValue9);
        const blocked = exhausted.submissions[0];
        assert(blocked?._tag === "CycleBlocked");
        const acknowledgements = yield* AttentionAcknowledgements;
        const needFor = (ask: CycleBudgetAsk) =>
          CycleBudgetNeed.make({
            id: `cycle-budget:${ask.id}`,
            ask,
            itemLabel: `${repository}#72`,
            itemUrl: "https://github.com/basaltbytes/usine/issues/72",
          });
        const dismiss = (ask: CycleBudgetAsk) =>
          acknowledgements.dismiss(
            AttentionAcknowledgement.make({
              ...attentionKey(needFor(ask)),
              dismissedBy: Option.none(),
              dismissedAt: DateTime.makeUnsafe("2026-11-02T19:45:00Z"),
            }),
          );
        const attention = Effect.gen(function* () {
          const asks = yield* budgets.asks;
          const dismissed = yield* acknowledgements.list;
          return partitionNeeds(asks.map(needFor), dismissed);
        });
        yield* dismiss(blocked.ask);
        const decodedValue8 = yield* withLoop(loop);
        yield* polling.poll(decodedValue8);

        assert.deepStrictEqual((yield* attention).needsYou, []);
        const sibling = LoopFile.make({ ...loop, name: LoopName.make("fix") });
        const decodedValue7 = yield* withLoop(sibling);
        const refused = (yield* polling.poll(decodedValue7)).submissions[0];
        assert(refused?._tag === "CycleBlocked");
        assert.strictEqual(refused.ask.id, blocked.ask.id);

        assert.deepStrictEqual((yield* attention).needsYou, [needFor(refused.ask)]);

        assert.deepStrictEqual((yield* attention).dismissedNeeds, []);
        assert.strictEqual(refused.ask.blockedLoop, sibling.name);
        assert.strictEqual(refused.ask.loop, loop.name);
        yield* dismiss(refused.ask);
        for (const unchanged of [loop, sibling]) {
          const loaded = yield* withLoop(unchanged);
          yield* polling.poll(loaded);
        }

        assert.deepStrictEqual((yield* attention).needsYou, []);

        assert.deepStrictEqual((yield* attention).dismissedNeeds, [needFor(refused.ask)]);
        hash = "c";
        const decodedValue6 = yield* withLoop(sibling);
        const changed = (yield* polling.poll(decodedValue6)).submissions[0];
        assert(changed?._tag === "CycleBlocked");

        assert.deepStrictEqual((yield* attention).needsYou, [needFor(changed.ask)]);
        assert.strictEqual(changed.ask.blockedLoop, sibling.name);
        shouldPause = true;
        const decodedValue5 = yield* withLoop(loop);
        const inFlight = yield* polling.poll(decodedValue5).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        ready = false;

        yield* budgets.reset(
          blocked.ask.id,
          Event.make({
            id: EventId.make("reset-in-flight"),
            dedupKey: DedupKey.make("reset-in-flight"),
            receivedAt: yield* DateTime.now,
            payload: {},
          }),
        );
        shouldPause = false;
        yield* Deferred.succeed(release, undefined);
        const stale = yield* Fiber.join(inFlight);
        assert.strictEqual(stale.submissions[0]?._tag, "Ignored");

        assert.strictEqual((yield* budgets.pendingResets).length, 1);
        const updated = yield* makeLoop("Updated task {{ item.number }}.", "required");
        const decodedValue4 = yield* withLoop(updated);
        const noMatch = yield* polling.poll(decodedValue4);
        assert.deepStrictEqual(noMatch.submissions, []);
        ready = true;
        const decodedValue3 = yield* withLoop(updated);
        const refreshed = yield* polling.poll(decodedValue3);
        const admitted = refreshed.submissions[0];
        assert(admitted?._tag === "Claimed");
        const saved = yield* engine.inspect(admitted.runId);
        assert.notStrictEqual(saved.event.id, blocked.eventId);
        assert.strictEqual(saved.task.trim(), "Updated task 72.");
        for (let attempt = 0; attempt < 500; attempt += 1) {
          if ((yield* engine.inspect(admitted.runId)).run.state._tag === "Waiting") break;
          yield* Effect.sleep("10 millis");
        }

        assert.strictEqual((yield* engine.inspect(admitted.runId)).run.state._tag, "Waiting");
        const currentAsks = yield* budgets.asks;
        assert.deepStrictEqual(currentAsks, []);
      }).pipe(Effect.provide(runtime));
    }).pipe(
      Effect.provide(
        ConfigParser.layer.pipe(
          Layer.provide(MarcbachmannCelLayer),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);
