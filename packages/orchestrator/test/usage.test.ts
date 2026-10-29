import { assert, describe, it } from "@effect/vitest";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, type Harness, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
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
import { DateTime, Effect, Layer, Logger, Option } from "effect";
import { RunUsageReader } from "../src/operator/usage.ts";

const now = DateTime.makeUnsafe("2026-10-26T09:00:00.000Z");
const runId = RunId.make("run");
const attemptId = AttemptId.make("run/1");
const brain = (harness: Harness, model: string) =>
  new BrainSpec({ harness, model: ModelId.make(model), effort: "high" });
const child = (id: string, harness: Harness, model: string, apiKey = false) =>
  new ChildSession({
    id: AgentSessionId.make(id),
    parentId: AgentSessionId.make("parent"),
    agent: AgentName.make("reviewer"),
    brain: brain(harness, model),
    gatewayCredential: apiKey ? Option.some("api-key") : Option.none(),
  });
const planParent = new ParentSession({
  id: AgentSessionId.make("parent"),
  agent: AgentName.make("developer"),
  brain: brain("pi", "openai-codex/gpt-5.6-terra"),
});
// 3K uncached input, 200K cache reads, 1K cache writes, and 1K output: 5K tokens.
const breakdown = new TokenBreakdown({
  input: 3_000,
  cachedInput: 200_000,
  cacheWrite: 1_000,
  output: 1_000,
});
// The same tokens at gpt-5.6-terra's rates per million: $2, $0.20, $2.50, and $12.
const terraPrice = (3_000 * 2 + 200_000 * 0.2 + 1_000 * 2.5 + 1_000 * 12) / 1_000_000;

const report = (
  sequence: number,
  session: ParentSession | ChildSession,
  usd: number | null,
  tokens: Option.Option<TokenBreakdown>,
) =>
  new TranscriptEntry({
    sequence: TranscriptSequence.make(sequence),
    attemptId,
    direction: "outbound",
    envelope: new AttemptChannel.OutboundEnvelope({
      version: AttemptChannel.PROTOCOL_VERSION,
      attemptId,
      sequence: AttemptChannel.Sequence.make(sequence),
      sentAt: now,
      payload: new AttemptChannel.SessionEvent({
        event: new SessionTokensUpdated({
          session,
          totalTokens: TokenCount.make(5_000),
          costUsd: usd === null ? Option.none() : Option.some(UsdAmount.make(usd)),
          breakdown: tokens,
        }),
      }),
    }),
    receivedAt: now,
  });

const source = {
  run: new Run({
    id: runId,
    eventId: EventId.make("event"),
    loop: LoopName.make("review-pr"),
    state: new RunState.Succeeded(),
    openedAt: now,
  }),
  attempts: [
    new Attempt({
      id: attemptId,
      runId,
      stepName: StepName.make("run"),
      worker: WorkerName.make("w1"),
      number: AttemptNumber.make(1),
      brain: brain("pi", "openai-codex/gpt-5.6-terra"),
      task: AttemptTask.make("Review it."),
      agent: AgentName.make("developer"),
      operatorIntervened: false,
      parentModel: Option.none(),
      startedAt: now,
      outcome: Option.some(new AttemptSucceeded()),
      endedAt: Option.some(now),
      salvage: Option.none(),
      start: Option.some(new StartedByEvent()),
    }),
  ],
};

const readerOf = (reports: ReadonlyArray<TranscriptEntry>) =>
  RunUsageReader.layer.pipe(
    Layer.provide(
      Layer.succeed(RunReader)({
        latestPoolRateLimits: () => Effect.succeed([]),
        inspect: () => Effect.die("unused"),
        evidence: () => Effect.die("unused"),
        list: () => Effect.die("unused"),
        closed: () => Effect.die("unused"),
        closedSince: () => Effect.die("unused"),
        forItems: () => Effect.die("unused"),
        events: () => Effect.die("unused"),
        revision: () => Effect.die("unused"),
        transcript: () => Effect.succeed(reports),
        attemptsByWorker: () => Effect.die("unused"),
        sightings: () => Effect.die("unused"),
      }),
    ),
  );

const costs = (
  sessions: ReadonlyArray<{ readonly cost: { usd: number; estimate: boolean } | null }>,
) => sessions.map(({ cost }) => (cost === null ? null : { ...cost }));

describe("RunUsageReader", () => {
  it.effect(
    "prices Codex sessions from the OpenAI table, marked an estimate only in the ChatGPT plan",
    () =>
      Effect.gen(function* () {
        const usage = yield* (yield* RunUsageReader).read(source);
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
            report(1, child("plan-codex", "codex", "gpt-5.6-terra"), null, Option.some(breakdown)),
            report(
              2,
              child("key-codex", "codex", "gpt-5.6-terra", true),
              null,
              Option.some(breakdown),
            ),
            report(3, planParent, 0.25, Option.none()),
            report(4, child("claude", "claude", "claude-opus-5-5"), 1.5, Option.none()),
          ]),
        ),
      ),
  );

  it.effect("leaves a Codex model without rates unpriced and logs it once", () => {
    const warnings: Array<string> = [];
    const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push(JSON.stringify(message));
    });
    return Effect.gen(function* () {
      const reader = yield* RunUsageReader;
      const usage = yield* reader.read(source);
      yield* reader.read(source);
      assert.deepStrictEqual(costs(usage.sessions), [null, null]);
      assert.deepStrictEqual(costs(usage.pools), [null]);
      assert.strictEqual(warnings.length, 1);
      assert.include(warnings[0], "gpt-7-nova");
    }).pipe(
      Effect.provide(
        readerOf([
          report(1, child("unknown", "codex", "gpt-7-nova"), null, Option.some(breakdown)),
          // Recorded before Codex reports had a breakdown: unpriced, but its model has rates.
          report(2, child("older", "codex", "gpt-5.6-terra"), null, Option.none()),
        ]),
      ),
      Effect.provide(Logger.layer([logger])),
    );
  });
});
