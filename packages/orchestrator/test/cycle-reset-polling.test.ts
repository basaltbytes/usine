import { NodeServices } from "@effect/platform-node";
import { AgentFile } from "@usine/config/agent";
import { InstancePath } from "@usine/config/file";
import type { LoopFile } from "@usine/config/loop";
import { ConfigParser } from "@usine/config/parser";
import { Event, EventId, DedupKey } from "@usine/core/event";
import { InstanceDirectory } from "@usine/core/instance";
import { StepResult } from "@usine/core/step/result";
import { WorkerName } from "@usine/core/worker";
import { RunEngine } from "@usine/engine/engine";
import { StepExecutor } from "@usine/engine/step-executor";
import { layer as localEngineLayer } from "@usine/engine/local-sqlite";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { ChangedIssue, ContentHash, IssueSnapshot, type IssuePayload } from "@usine/github/polling";
import { Deferred, Fiber, FileSystem, Layer } from "effect";
import { inertLabelReconcilerLayer } from "./support/polling.ts";
import { assert, describe, it } from "@effect/vitest";
import { UsineConfig } from "@usine/config/factory";
import { LoadedInstance } from "@usine/config/instance";
import { ItemKey } from "@usine/core/item";
import { RepositoryName } from "@usine/core/repository";
import { CycleBudgetReset, CycleBudgets } from "@usine/engine/cycle-budget";
import { GitHubApiError } from "@usine/github/github-app";
import {
  EntityTag,
  GitHubPolling,
  PollCursor,
  RepositoryChanges,
  RepositoryLabelCatalog,
} from "@usine/github/polling";
import { DateTime, Effect, Option, Schema } from "effect";
import { PollingTriggers } from "../src/polling-triggers.ts";
import { emptyCycleBudgets, memoryCursorStore, pollingTestLayer } from "./support/polling.ts";

const repository = RepositoryName.make("basaltbytes/usine");
const instance = new LoadedInstance({
  config: Schema.decodeUnknownSync(UsineConfig)({ version: 1, repos: [{ name: repository }] }),
  agents: [],
  invalidAgents: [],
  loops: [],
  quarantinedLoops: [],
  warnings: [],
});

describe("cycle reset polling", () => {
  it.effect(
    "restarts cursors after reset, retains failed refreshes, and continues a committed backlog",
    () => {
      const cursors = memoryCursorStore();
      const fresh = new PollCursor({
        entityTag: Option.some(EntityTag.make('"fresh"')),
        watermark: Option.some(DateTime.makeUnsafe("2026-09-05T00:00:00Z")),
      });
      const reset = Schema.decodeUnknownSync(CycleBudgetReset)({
        itemKey: ItemKey.make("pr-72"),
        repository,
        generation: 1,
      });
      let pending: ReadonlyArray<CycleBudgetReset> = [];
      let fails = false;
      const seen: Array<PollCursor> = [];
      const acknowledgements: Array<CycleBudgetReset> = [];
      const budgets: CycleBudgets["Service"] = {
        ...emptyCycleBudgets,
        pendingResets: () => Effect.sync(() => pending),
        acknowledgeReset: (value) =>
          Effect.sync(() => {
            // Cursor progress must already be durable when the reset is acknowledged.
            assert(cursors.stored.size > 0);
            acknowledgements.push(value);
            pending = [];
          }),
      };
      const github: GitHubPolling["Service"] = {
        labels: () =>
          Effect.succeed(new RepositoryLabelCatalog({ labels: [], entityTag: Option.none() })),
        snapshot: () => Effect.die("no Items on this page"),
        changes: (_repository, cursor) =>
          Effect.gen(function* () {
            seen.push(cursor);
            if (fails)
              return yield* new GitHubApiError({
                operation: "poll-repository-changes",
                status: Option.some(503),
                message: "unavailable",
              });
            return new RepositoryChanges({
              cursor: fresh,
              items: [],
              backlog: true,
              nextPollAt: Option.none(),
            });
          }),
      };
      return Effect.gen(function* () {
        const polling = yield* PollingTriggers;
        yield* polling.poll(instance);
        yield* polling.poll(instance);
        assert.deepStrictEqual(seen[1], fresh);
        pending = [reset];
        fails = true;
        assert.strictEqual((yield* polling.poll(instance)).failures.length, 1);
        assert.deepStrictEqual(seen[2], PollCursor.empty);
        assert.deepStrictEqual(pending, [reset]);
        assert.deepStrictEqual(acknowledgements, []);
        fails = false;
        yield* polling.poll(instance);
        assert.deepStrictEqual(seen[3], PollCursor.empty);
        assert.deepStrictEqual(acknowledgements, [reset]);
        yield* polling.poll(instance);
        assert.deepStrictEqual(seen[4], fresh);
      }).pipe(
        Effect.provide(pollingTestLayer(github, [], undefined, undefined, cursors.store, budgets)),
      );
    },
  );
});

it.live(
  "discards a poll rendered before reset and uses current input and configuration afterward",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fs.makeTempDirectoryScoped({ prefix: "usine-reset-race-" }),
      );
      const parser = yield* ConfigParser;
      const makeLoop = (body: string, approval: "none" | "required") =>
        parser.parseLoopFile(
          InstancePath.make("loops/review.md"),
          `---\ntrigger:\n  on: issue\n  if: 'item.labels.nodes.exists(l, l.name == "ready")'\nmax_cycles: 1\napproval: ${approval}\nagent: reviewer\n---\n${body}`,
        );
      const loop = yield* makeLoop("Original task {{ item.number }}.", "none");
      const agent = Schema.decodeUnknownSync(AgentFile)({
        name: "reviewer",
        harness: "codex",
        model: "test-model",
        effort: "high",
        parentModel: Option.none(),
        parentEffort: Option.none(),
        persona: "Review this Item.",
      });
      const withLoop = (loop: LoopFile) =>
        new LoadedInstance({ ...instance, agents: [agent], loops: [loop] });
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
        labels: { totalCount: ready ? 1 : 0, nodes: ready ? [{ name: "ready" }] : [] },
        assignees: { totalCount: 0, nodes: [] },
        comments: { totalCount: 0, nodes: [] },
        closedByPullRequestsReferences: { totalCount: 0, nodes: [] },
      });
      const github: GitHubPolling["Service"] = {
        labels: () =>
          Effect.succeed(new RepositoryLabelCatalog({ labels: [], entityTag: Option.none() })),
        changes: () =>
          Effect.succeed(
            new RepositoryChanges({
              cursor: PollCursor.empty,
              items: [
                new ChangedIssue({
                  number: 72,
                  updatedAt: DateTime.makeUnsafe("2026-09-05T00:00:00Z"),
                }),
              ],
              backlog: false,
              nextPollAt: Option.none(),
            }),
          ),
        snapshot: () =>
          Effect.sync(
            () =>
              new IssueSnapshot({
                payload: payload(),
                contentHash: ContentHash.make(hash.repeat(64)),
              }),
          ),
      };
      const executor = Layer.succeed(StepExecutor)({
        intervene: () => Effect.void,
        reserve: () => Effect.succeed({ worker: WorkerName.make("test"), release: Effect.void }),
        interrupt: () => Effect.void,
        execute: () => Effect.succeed(new StepResult({ message: "Reviewed", facts: [] })),
      });
      const engineLayer = localEngineLayer(directory).pipe(Layer.provide(executor));
      const dependencies = Layer.mergeAll(
        engineLayer,
        controlledParser,
        MarcbachmannCelLayer,
        inertLabelReconcilerLayer,
        Layer.succeed(GitHubPolling)(github),
      );
      const runtime = Layer.merge(
        dependencies,
        PollingTriggers.layer.pipe(Layer.provide(dependencies)),
      );
      yield* Effect.gen(function* () {
        const polling = yield* PollingTriggers;
        const engine = yield* RunEngine;
        const budgets = yield* CycleBudgets;
        const initial = yield* polling.poll(withLoop(loop));
        const first = initial.submissions[0];
        assert(first?._tag === "Claimed");
        for (let attempt = 0; attempt < 500; attempt += 1) {
          if ((yield* engine.inspect(first.runId)).run.state._tag === "Succeeded") break;
          yield* Effect.sleep("10 millis");
        }
        assert.strictEqual((yield* engine.inspect(first.runId)).run.state._tag, "Succeeded");
        hash = "b";
        const exhausted = yield* polling.poll(withLoop(loop));
        const blocked = exhausted.submissions[0];
        assert(blocked?._tag === "CycleBlocked");
        shouldPause = true;
        const inFlight = yield* polling.poll(withLoop(loop)).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        ready = false;
        yield* budgets.reset(
          blocked.ask.id,
          new Event({
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
        assert.strictEqual((yield* budgets.pendingResets()).length, 1);
        const updated = yield* makeLoop("Updated task {{ item.number }}.", "required");
        const noMatch = yield* polling.poll(withLoop(updated));
        assert.deepStrictEqual(noMatch.submissions, []);
        ready = true;
        const refreshed = yield* polling.poll(withLoop(updated));
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
        assert.deepStrictEqual(yield* budgets.asks(), []);
      }).pipe(Effect.provide(runtime));
    }).pipe(
      Effect.provide(ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer))),
      Effect.provide(NodeServices.layer),
    ),
);
