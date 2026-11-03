import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { ChangeBus, changeBusLayer, type ChangeTarget } from "@usine/core/changes";
import { CycleLimit } from "@usine/core/cycle-budget";
import { Event, EventId, DedupKey } from "@usine/core/event";
import { InstanceDirectory } from "@usine/core/instance";
import { ItemKey, ItemNumber } from "@usine/core/item";
import {
  AgentSessionId,
  ParentSession,
  PoolRateLimitsUpdated,
  RateLimitsSnapshot,
  RateLimitWindow,
} from "@usine/core/agent/session";
import { TestClock } from "effect/testing";
import { ModelId } from "@usine/core/agent/brain";
import { RunId } from "@usine/core/run";
import { StepResult } from "@usine/core/step/result";
import { WorkerName } from "@usine/core/worker";
import {
  OutboundEnvelope,
  PROTOCOL_VERSION,
  Sequence,
  Started,
  SessionEvent,
} from "@usine/core/attempt/channel";
import { DateTime, Effect, FileSystem, Layer, Option, Result } from "effect";
import { sqliteTempDirectory } from "../../../../tooling/test/sqlite.mts";
import {
  AttentionAcknowledgements,
  AttentionAcknowledgement,
  AttentionKey,
  AttentionRevision,
} from "../../src/attention/attention.ts";
import { CycleBudgets } from "../../src/cycle-budget/cycle-budget.ts";
import { localSqliteLayer } from "../../src/database/local-sqlite.ts";
import { Submission } from "../../src/engine/submission.ts";
import {
  ItemProjectionWriter,
  ItemProjection,
  ItemProjectionSource,
  ItemContentHash,
} from "../../src/item-projection/item-projection.ts";
import { RunDatabase } from "../../src/database/database.ts";
import { changeTransaction } from "../../src/store/changes.ts";
import { RunStore } from "../../src/store/store.ts";
import { lifecycleSubmission } from "./support.ts";

it.effect(
  "publishes committed engine, transcript, item, attention and cycle writes once and skips duplicates",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fs.makeTempDirectoryScoped({ directory: sqliteTempDirectory() }),
      );
      const services = Layer.mergeAll(
        RunStore.layer,
        ItemProjectionWriter.layer,
        AttentionAcknowledgements.layer,
        CycleBudgets.layer,
      ).pipe(Layer.provideMerge(localSqliteLayer(directory)));
      yield* Effect.gen(function* () {
        const bus = yield* ChangeBus;
        const store = yield* RunStore;
        const start = Submission.make({
          ...lifecycleSubmission,
          cycleLimit: Option.some(CycleLimit.make(1)),
        });
        const run = RunId.make("changes-run");
        const audience = { _tag: "Repository", repository: start.repository } as const;
        const expectWrite = <A, E, R>(
          operation: Effect.Effect<A, E, R>,
          targets: ReadonlyArray<ChangeTarget>,
        ) =>
          Effect.gen(function* () {
            const before = (yield* bus.open).revision;
            const result = yield* operation;
            const after = yield* bus.open;
            assert.strictEqual(after.revision, before + 1);
            const notice = after.history.at(-1);
            assert(notice !== undefined);
            for (const target of targets) assert.deepInclude(notice.changes, { audience, target });
            assert.strictEqual(
              new Set(notice.changes.map((entry) => JSON.stringify(entry))).size,
              notice.changes.length,
            );
            return result;
          });
        const expectUnchanged = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
          Effect.gen(function* () {
            const before = (yield* bus.open).revision;
            yield* operation;
            assert.strictEqual((yield* bus.open).revision, before);
          });
        const transaction = changeTransaction(yield* RunDatabase, bus);
        yield* expectUnchanged(
          transaction((_database, record) =>
            record({ audience, target: { kind: "run", id: "rolled-back" } }).pipe(
              Effect.andThen(Effect.fail("aborted" as const)),
            ),
          ).pipe(Effect.flip),
        );
        yield* expectWrite(store.recordAndClaim(start, run), [{ kind: "run", id: run }]);
        yield* expectUnchanged(store.recordAndClaim(start, run));
        const started = yield* expectWrite(
          store.beginAttempt(run, WorkerName.make("local"), Option.none()),
          [{ kind: "run", id: run }],
        );
        assert(started._tag === "AttemptStarted");
        const attempt = started.execution.attempt;
        const envelope = OutboundEnvelope.make({
          version: PROTOCOL_VERSION,
          attemptId: attempt.id,
          sequence: Sequence.make(1),
          sentAt: yield* DateTime.now,
          payload: Started.make({ parentModel: ModelId.make("actual-model") }),
        });
        yield* expectWrite(store.appendTranscript("outbound", envelope), [
          { kind: "attempt", id: attempt.id },
        ]);
        yield* expectUnchanged(store.appendTranscript("outbound", envelope));
        const report = PoolRateLimitsUpdated.make({
          session: ParentSession.make({
            id: AgentSessionId.make("pool-session"),
            agent: attempt.agent,
            brain: attempt.brain,
          }),
          pool: "chatgptPlan",
          login: Option.none(),
          rateLimits: RateLimitsSnapshot.make({
            limitId: Option.none(),
            limitName: Option.none(),
            secondary: Option.none(),
            primary: Option.some(
              RateLimitWindow.make({
                usedPercent: 90,
                windowDurationMinutes: Option.some(60),
                resetsAt: Option.some(DateTime.add(yield* DateTime.now, { minutes: 1 })),
              }),
            ),
          }),
        });
        yield* expectWrite(
          store.appendTranscript(
            "outbound",
            OutboundEnvelope.make({
              ...envelope,
              sequence: Sequence.make(2),
              payload: SessionEvent.make({ event: report }),
            }),
          ),
          [{ kind: "attempt", id: attempt.id }],
        );
        const beforeReset = (yield* bus.open).revision;
        yield* TestClock.adjust("1 minute");
        assert.strictEqual((yield* bus.open).revision, beforeReset + 1);
        assert.deepStrictEqual((yield* bus.open).history.at(-1)?.changes, [
          { audience: { _tag: "Instance" }, target: { kind: "attention", id: "instance" } },
        ]);
        yield* expectWrite(
          store.finishAttempt(
            attempt,
            Result.succeed(StepResult.make({ message: "done", facts: [] })),
          ),
          [
            { kind: "attempt", id: attempt.id },
            { kind: "run", id: run },
          ],
        );
        yield* expectUnchanged(store.beginAttempt(run, WorkerName.make("local"), Option.none()));
        const next = Submission.make({
          ...start,
          event: Event.make({
            ...start.event,
            id: EventId.make("next-event"),
            dedupKey: DedupKey.make("next-event"),
          }),
        });
        const blocked = yield* expectWrite(store.recordAndClaim(next, RunId.make("blocked")), [
          { kind: "attention", id: "instance" },
          { kind: "item", id: start.itemKey },
        ]);
        assert(blocked.result._tag === "CycleBlocked");
        yield* expectUnchanged(store.recordAndClaim(next, RunId.make("blocked")));
        const budgets = yield* CycleBudgets;
        const later = Submission.make({
          ...next,
          event: Event.make({
            ...next.event,
            id: EventId.make("later-event"),
            dedupKey: DedupKey.make("later-event"),
          }),
        });
        yield* expectWrite(store.recordAndClaim(later, RunId.make("later-blocked")), [
          { kind: "attention", id: "instance" },
          { kind: "item", id: start.itemKey },
        ]);
        yield* expectWrite(budgets.close(blocked.result.ask.id, "ItemClosed"), [
          { kind: "attention", id: "instance" },
          { kind: "item", id: start.itemKey },
        ]);
        yield* expectUnchanged(budgets.close(blocked.result.ask.id, "ItemClosed"));
        const reopened = yield* expectWrite(store.recordAndClaim(next, RunId.make("blocked")), [
          { kind: "attention", id: "instance" },
          { kind: "item", id: start.itemKey },
        ]);
        assert(reopened.result._tag === "CycleBlocked");
        const answer = Event.make({
          ...start.event,
          id: EventId.make("reset"),
          dedupKey: DedupKey.make("reset"),
        });
        yield* expectWrite(budgets.reset(reopened.result.ask.id, answer), [
          { kind: "attention", id: "instance" },
          { kind: "item", id: start.itemKey },
        ]);
        yield* expectUnchanged(budgets.reset(reopened.result.ask.id, answer));
        const item = ItemProjection.make({
          itemKey: ItemKey.make("older-linked-pr"),
          repository: start.repository,
          number: ItemNumber.make(41),
          source: ItemProjectionSource.make("pr"),
          contentHash: ItemContentHash.make("clean"),
          payload: { mergeable: "MERGEABLE", labels: [] },
        });
        const writer = yield* ItemProjectionWriter;
        yield* expectWrite(writer.upsert(item), [{ kind: "item", id: item.itemKey }]);
        for (const [contentHash, payload] of [
          ["conflicting", { mergeable: "CONFLICTING", labels: [] }],
          ["labelled", { mergeable: "CONFLICTING", labels: ["review"] }],
        ] as const)
          yield* expectWrite(
            writer.upsert(
              ItemProjection.make({
                ...item,
                contentHash: ItemContentHash.make(contentHash),
                payload: { ...payload, labels: [...payload.labels] },
              }),
            ),
            [{ kind: "item", id: item.itemKey }],
          );
        yield* expectWrite(writer.markGone(item.itemKey, yield* DateTime.now), [
          { kind: "item", id: item.itemKey },
        ]);
        yield* expectUnchanged(writer.markGone(item.itemKey, yield* DateTime.now));
        const acknowledgements = yield* AttentionAcknowledgements;
        const acknowledgement = AttentionAcknowledgement.make({
          id: "need",
          revision: AttentionRevision.make("revision"),
          dismissedBy: Option.none(),
          dismissedAt: yield* DateTime.now,
        });
        yield* expectWrite(acknowledgements.dismiss(acknowledgement, [audience]), [
          { kind: "attention", id: "instance" },
        ]);
        yield* expectUnchanged(acknowledgements.dismiss(acknowledgement, [audience]));
        yield* expectWrite(acknowledgements.undo(AttentionKey.make(acknowledgement), [audience]), [
          { kind: "attention", id: "instance" },
        ]);
        yield* expectUnchanged(
          acknowledgements.undo(AttentionKey.make(acknowledgement), [audience]),
        );
      }).pipe(Effect.provide(services));
    }).pipe(Effect.provide([NodeServices.layer, changeBusLayer]), Effect.scoped),
);

it.effect("restores only the latest future pool reset deadlines after a store restart", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = InstanceDirectory.make(
      yield* fs.makeTempDirectoryScoped({ directory: sqliteTempDirectory() }),
    );
    const bus = yield* ChangeBus;
    const now = yield* DateTime.now;
    const withStore = <A, E, R>(operation: Effect.Effect<A, E, R | RunStore>) =>
      operation.pipe(
        Effect.provide(RunStore.layer.pipe(Layer.provide(localSqliteLayer(directory)))),
        Effect.scoped,
      );
    yield* withStore(
      Effect.gen(function* () {
        const store = yield* RunStore;
        const run = RunId.make("restart-pool-run");
        yield* store.recordAndClaim(lifecycleSubmission, run);
        const started = yield* store.beginAttempt(run, WorkerName.make("local"), Option.none());
        assert(started._tag === "AttemptStarted");
        const attempt = started.execution.attempt;
        for (const [index, pool, primaryMinutes, secondaryMinutes] of [
          [1, "chatgptPlan", 1, 1],
          [2, "chatgptPlan", 2, 3],
          [3, "claudePlan", -1, -1],
        ] as const) {
          const window = (minutes: number) =>
            Option.some(
              RateLimitWindow.make({
                usedPercent: 90,
                windowDurationMinutes: Option.some(60),
                resetsAt: Option.some(DateTime.add(now, { minutes })),
              }),
            );
          yield* store.appendTranscript(
            "outbound",
            OutboundEnvelope.make({
              version: PROTOCOL_VERSION,
              attemptId: attempt.id,
              sequence: Sequence.make(index),
              sentAt: now,
              payload: SessionEvent.make({
                event: PoolRateLimitsUpdated.make({
                  session: ParentSession.make({
                    id: AgentSessionId.make("restart-pool-session"),
                    agent: attempt.agent,
                    brain: attempt.brain,
                  }),
                  pool,
                  login: Option.none(),
                  rateLimits: RateLimitsSnapshot.make({
                    limitId: Option.none(),
                    limitName: Option.none(),
                    primary: window(primaryMinutes),
                    secondary: window(secondaryMinutes),
                  }),
                }),
              }),
            }),
          );
        }
      }),
    );
    const beforeRestart = (yield* bus.open).revision;
    yield* withStore(
      Effect.gen(function* () {
        yield* RunStore;
        yield* TestClock.adjust("1 minute");
        assert.strictEqual((yield* bus.open).revision, beforeRestart);
        for (const count of [1, 2]) {
          yield* TestClock.adjust("1 minute");
          const snapshot = yield* bus.open;
          assert.strictEqual(snapshot.revision, beforeRestart + count);
          assert.deepStrictEqual(snapshot.history.at(-1)?.changes, [
            { audience: { _tag: "Instance" }, target: { kind: "attention", id: "instance" } },
          ]);
        }
        yield* TestClock.adjust("1 hour");
        assert.strictEqual((yield* bus.open).revision, beforeRestart + 2);
      }),
    );
  }).pipe(Effect.provide([NodeServices.layer, changeBusLayer]), Effect.scoped),
);
