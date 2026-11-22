import { jsonKey } from "@usine/core/json-key";
import { assert, describe, it } from "@effect/vitest";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  EndpointName,
  ChildSession,
  ParentSession,
  SessionTokensUpdated,
  TokenBreakdown,
  TokenCount,
  UsdAmount,
} from "@usine/core/agent/session";
import { Attempt, AttemptId, AttemptNumber, AttemptTask } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AttemptSucceeded } from "@usine/core/attempt/outcome";
import { StartedByEvent } from "@usine/core/attempt/start";
import { EventId } from "@usine/core/event";
import { LoopName } from "@usine/core/loop";
import { Run, RunId } from "@usine/core/run";
import * as RunState from "@usine/core/run/state";
import { StepName } from "@usine/core/step";
import { WorkerName } from "@usine/core/worker";
import { RunReader } from "@usine/engine/run-reader";
import { TranscriptEntry, TranscriptSequence } from "@usine/engine/transcript";
import {
  AdmissionContext,
  admitBrain,
  catalog,
  codingAgent,
  HarnessCatalog,
  HarnessDescriptor,
  HarnessPool,
} from "@usine/agents/harness";
import { BillingPool, BillingPools, PoolDescriptor } from "@usine/core/agent/pool";
import { DateTime, Effect, Layer, Logger, Option, Result, Schema } from "effect";
import { RunUsageReader, runUsageSource, taskUsage } from "../src/operator/usage.ts";

const now = DateTime.makeUnsafe("2026-10-26T09:00:00.000Z");
const runId = RunId.make("run");
const attemptId = AttemptId.make("run/1");
const brain = (harness: Harness, model: string) =>
  BrainSpec.make({ harness, model: ModelId.make(model), effort: "high" });
const child = (id: string, harness: Harness, model: string, apiKey = false) =>
  ChildSession.make({
    id: AgentSessionId.make(id),
    parentId: AgentSessionId.make("parent"),
    agent: AgentName.make("reviewer"),
    brain: brain(harness, model),
    gatewayCredential: apiKey ? Option.some("api-key") : Option.none(),
  });
const planParent = ParentSession.make({
  id: AgentSessionId.make("parent"),
  agent: AgentName.make("developer"),
  brain: brain(Harness.make("pi"), "openai-codex/gpt-5.6-terra"),
});
// 3K uncached input, 200K cache reads, 1K cache writes, and 1K output: 5K tokens.
const breakdown = TokenBreakdown.make({
  input: 3000,
  cachedInput: 200000,
  cacheWrite: 1000,
  output: 1000,
});
// The same tokens at gpt-5.6-terra's rates per million: $2, $0.20, $2.50, and $12.
const terraPrice = (3_000 * 2 + 200_000 * 0.2 + 1_000 * 2.5 + 1_000 * 12) / 1_000_000;

const report = (
  sequence: number,
  session: ParentSession | ChildSession,
  usd: number | null,
  tokens: Option.Option<TokenBreakdown>,
) =>
  TranscriptEntry.make({
    sequence: TranscriptSequence.make(sequence),
    attemptId,
    direction: "outbound",
    envelope: AttemptChannel.OutboundEnvelope.make({
      version: AttemptChannel.PROTOCOL_VERSION,
      attemptId,
      sequence: AttemptChannel.Sequence.make(sequence),
      sentAt: now,
      payload: AttemptChannel.SessionEvent.make({
        event: SessionTokensUpdated.make({
          session,
          totalTokens: TokenCount.make(5000),
          costUsd: usd === null ? Option.none() : Option.some(UsdAmount.make(usd)),
          breakdown: tokens,
        }),
      }),
    }),
    receivedAt: now,
  });

const source = {
  run: Run.make({
    id: runId,
    eventId: EventId.make("event"),
    loop: LoopName.make("review-pr"),
    state: RunState.Succeeded.make(),
    openedAt: now,
  }),
  attempts: [
    Attempt.make({
      id: attemptId,
      runId,
      stepName: StepName.make("run"),
      worker: WorkerName.make("w1"),
      number: AttemptNumber.make(1),
      brain: brain(Harness.make("pi"), "openai-codex/gpt-5.6-terra"),
      task: AttemptTask.make("Review it."),
      agent: AgentName.make("developer"),
      operatorIntervened: false,
      parentModel: Option.none(),
      startedAt: now,
      outcome: Option.some(AttemptSucceeded.make()),
      endedAt: Option.some(now),
      salvage: Option.none(),
      start: Option.some(StartedByEvent.make()),
    }),
  ],
};

const readerOf = (
  reports: ReadonlyArray<TranscriptEntry>,
  pools: ReadonlyArray<PoolDescriptor> = catalog.pools,
) =>
  RunUsageReader.layer.pipe(
    Layer.provideMerge(Layer.succeed(BillingPools)(pools)),
    Layer.provide(
      Layer.succeed(RunReader)({
        runForEvent: () => Effect.die("unused"),
        ciFixRuns: () => Effect.succeed(new Map()),
        latestPoolRateLimits: Effect.succeed([]),
        inspect: () => Effect.die("unused"),
        summary: () => Effect.die("unused"),
        evidence: () => Effect.die("unused"),
        list: () => Effect.die("unused"),
        closed: () => Effect.die("unused"),
        closedSince: () => Effect.die("unused"),
        board: () => Effect.die("unused"),
        forItems: () => Effect.die("unused"),
        events: () => Effect.die("unused"),
        revision: Effect.die("unused"),
        transcript: () => Effect.succeed(reports),
        attemptsByWorker: Effect.die("unused"),
        sightings: () => Effect.die("unused"),
      }),
    ),
  );

const costs = (
  sessions: ReadonlyArray<{ readonly cost: { usd: number; estimate: boolean } | null }>,
) => sessions.map(({ cost }) => (cost === null ? null : { ...cost }));

describe("RunUsageReader", () => {
  it.effect("prices recorded local claude API-key usage without a plan estimate", () =>
    Effect.gen(function* () {
      const session = ChildSession.make({
        ...child("local-key", Harness.make("claude"), "gpt-5.6-terra"),
        pool: Option.some(BillingPool.make("apiKeys")),
      });
      const entry = report(1, session, 1.5, Option.some(breakdown));
      const codec = Schema.fromJsonString(Schema.toCodecJson(TranscriptEntry));
      const stored = yield* Schema.encodeEffect(codec)(entry);
      const restored = yield* Schema.decodeEffect(codec)(stored);
      const usage = yield* Effect.gen(function* () {
        return yield* (yield* RunUsageReader).read(runUsageSource(source));
      }).pipe(Effect.provide(readerOf([restored])));
      assert.deepStrictEqual(
        usage.sessions.map(({ pool }) => pool),
        ["apiKeys"],
      );
      assert.deepStrictEqual(costs(usage.sessions), [{ usd: 1.5, estimate: false }]);
    }),
  );

  it.effect(
    "prices Codex sessions from the OpenAI table, marked an estimate only in the ChatGPT plan",
    () =>
      Effect.gen(function* () {
        const usage = yield* (yield* RunUsageReader).read(runUsageSource(source));
        assert.deepStrictEqual(
          usage.sessions.map(({ session, pool }) => [session.id, pool]),
          [
            ["plan-codex", "chatgptPlan"],
            ["key-codex", "apiKeys"],
            ["parent", "chatgptPlan"],
            ["claude", "claudePlan"],
          ],
        );
        assert.deepStrictEqual(costs(usage.sessions), [
          { usd: terraPrice, estimate: true },
          { usd: terraPrice, estimate: false },
          // Pi and the Agent SDK price their own sessions.
          { usd: 0.25, estimate: true },
          { usd: 1.5, estimate: true },
        ]);
        assert.deepStrictEqual(costs(usage.pools), [
          { usd: terraPrice, estimate: false },
          { usd: 1.5, estimate: true },
          { usd: terraPrice + 0.25, estimate: true },
        ]);
      }).pipe(
        Effect.provide(
          readerOf([
            report(
              1,
              child("plan-codex", Harness.make("codex"), "gpt-5.6-terra"),
              null,
              Option.some(breakdown),
            ),
            report(
              2,
              child("key-codex", Harness.make("codex"), "gpt-5.6-terra", true),
              null,
              Option.some(breakdown),
            ),
            report(3, planParent, 0.25, Option.none()),
            report(
              4,
              child("claude", Harness.make("claude"), "claude-opus-5-5"),
              1.5,
              Option.none(),
            ),
          ]),
        ),
      ),
  );

  it.effect(
    "bills recorded pools independently of harness and model inference, and undeclared pools last under their IDs",
    () => {
      const parent = ParentSession.make({
        ...planParent,
        pool: Option.some(BillingPool.make("apiKeys")),
        endpoint: Option.some(EndpointName.make("private-endpoint")),
      });
      const added = ChildSession.make({
        ...child("new", Harness.make("new-harness"), "qwen"),
        pool: Option.some(BillingPool.make("apiKeys")),
        endpoint: Option.some(EndpointName.make("ollama")),
      });
      // Pools of a removed harness, which the catalog no longer declares.
      const removed = ChildSession.make({
        ...child("removed", Harness.make("removed-harness"), "old-model"),
        pool: Option.some(BillingPool.make("removedPlan")),
      });
      const archived = ChildSession.make({
        ...child("archived", Harness.make("removed-harness"), "old-model"),
        pool: Option.some(BillingPool.make("archivedPlan")),
      });
      const lines = (
        pools: ReadonlyArray<{
          readonly pool: string;
          readonly label: string;
          readonly cost: { usd: number; estimate: boolean } | null;
        }>,
      ) => pools.map(({ pool, label, cost }) => [pool, label, cost === null ? null : { ...cost }]);
      const expected = [
        ["apiKeys", "API keys", { usd: 0.75, estimate: false }],
        ["archivedPlan", "archivedPlan", { usd: 2, estimate: false }],
        ["removedPlan", "removedPlan", { usd: 1, estimate: false }],
      ];
      return Effect.gen(function* () {
        const usage = yield* (yield* RunUsageReader).read(runUsageSource(source));
        assert.deepStrictEqual(
          usage.sessions.map(({ pool, session }) => [pool, session.endpoint]),
          [
            ["removedPlan", removed.endpoint],
            ["apiKeys", parent.endpoint],
            ["archivedPlan", archived.endpoint],
            ["apiKeys", added.endpoint],
          ],
        );
        assert.deepStrictEqual(lines(usage.pools), expected);
        const task = taskUsage(
          catalog.pools,
          [{ id: runId, attempts: [] }],
          new Map([[runId, usage]]),
        );
        assert.deepStrictEqual(lines(task.pools), expected);
      }).pipe(
        Effect.provide(
          readerOf([
            report(1, removed, 1, Option.none()),
            report(2, parent, 0.25, Option.none()),
            report(3, archived, 2, Option.none()),
            report(4, added, 0.5, Option.none()),
          ]),
        ),
      );
    },
  );

  it.effect(
    "lists a plan pool that only a test harness declares under its label, as an estimate",
    () => {
      const testPlan = PoolDescriptor.make({
        id: BillingPool.make("testPlan"),
        label: "Test plan",
        billing: "plan",
        windows: "separately",
      });
      const claude = catalog.get(Harness.make("claude"));
      assert(Option.isSome(claude));
      const testHarness = HarnessDescriptor.make({
        ...claude.value,
        id: Harness.make("test-harness"),
        label: "Test harness",
        pools: [HarnessPool.make({ pool: testPlan, routes: ["gateway-subscription"] })],
      });
      const extended = HarnessCatalog.make({ descriptors: [...catalog.descriptors, testHarness] });
      const admitted = admitBrain(
        extended,
        codingAgent,
        brain(testHarness.id, "test-model"),
        AdmissionContext.make({ placement: "local", credential: "gateway-subscription" }),
      );
      assert(Result.isSuccess(admitted));
      // A runtime records the pool that admission determined on the session it opens.
      const session = ChildSession.make({
        ...child("test", testHarness.id, "test-model"),
        pool: admitted.success.pool,
      });
      return Effect.gen(function* () {
        const usage = yield* (yield* RunUsageReader).read(runUsageSource(source));
        assert.deepStrictEqual(
          usage.pools.map(({ pool, label, cost }) => [pool, label, cost?.estimate]),
          [["testPlan", "Test plan", true]],
        );
        const task = taskUsage(
          extended.pools,
          [{ id: runId, attempts: [] }],
          new Map([[runId, usage]]),
        );
        assert.deepStrictEqual(
          task.pools.map(({ pool, label }) => [pool, label]),
          [["testPlan", "Test plan"]],
        );
      }).pipe(Effect.provide(readerOf([report(1, session, 2, Option.none())], extended.pools)));
    },
  );

  it.effect("leaves a Codex model without rates unpriced and logs it once", () => {
    const warnings: Array<string> = [];
    const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push(jsonKey(message));
    });
    return Effect.gen(function* () {
      const reader = yield* RunUsageReader;
      const usage = yield* reader.read(runUsageSource(source));
      yield* reader.read(runUsageSource(source));
      assert.deepStrictEqual(costs(usage.sessions), [null, null]);
      assert.deepStrictEqual(costs(usage.pools), [null]);
      assert.strictEqual(warnings.length, 1);
      assert.include(warnings[0], "gpt-7-nova");
    }).pipe(
      Effect.provide(
        readerOf([
          report(
            1,
            child("unknown", Harness.make("codex"), "gpt-7-nova"),
            null,
            Option.some(breakdown),
          ),
          // Recorded before Codex reports had a breakdown: unpriced, but its model has rates.
          report(2, child("older", Harness.make("codex"), "gpt-5.6-terra"), null, Option.none()),
        ]).pipe(Layer.provideMerge(Logger.layer([logger]))),
      ),
    );
  });
});
