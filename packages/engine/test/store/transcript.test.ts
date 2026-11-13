import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  AgentSessionId,
  ChildSession,
  ParentSession,
  SessionTokensUpdated,
  TextOutput,
  TokenCount,
  UsdAmount,
} from "@usine/core/agent/session";
import { AttemptTask } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { DedupKey, Event, EventId } from "@usine/core/event";
import { InstanceDirectory } from "@usine/core/instance";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { StepName } from "@usine/core/step";
import { WorkerName } from "@usine/core/worker";
import { eq, sql } from "drizzle-orm";
import { DateTime, Effect, FileSystem, Logger, Option, References, Schema, Layer } from "effect";

import { sqliteTempDirectory } from "../../../../tooling/test/sqlite.mts";
import { RunDatabase } from "../../src/database/database.ts";
import { localSqliteLayer } from "../../src/database/local-sqlite.ts";
import { attemptTranscripts } from "../../src/database/schema.ts";
import { Submission } from "../../src/engine/submission.ts";
import { RunStore } from "../../src/store/store.ts";
import { TranscriptAllQuery, TranscriptUsageQuery } from "../../src/transcript.ts";
import { lifecycleSubmission, testAgent } from "./support.ts";

describe("Attempt transcripts", () => {
  it.live("matches transcript usage across attempts, out-of-order reports, and redelivery", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const currentDirectory = yield* fileSystem.makeTempDirectoryScoped({
        directory: sqliteTempDirectory(),
        prefix: "usine-store-usage-",
      });
      const directory = InstanceDirectory.make(currentDirectory);
      yield* Effect.gen(function* () {
        const store = yield* RunStore;
        const database = yield* RunDatabase;
        for (const index of [0, 1]) {
          const submission = Submission.make({
            ...lifecycleSubmission,
            itemKey: ItemKey.make(`usage-item-${index}`),
            event: Event.make({
              ...lifecycleSubmission.event,
              id: EventId.make(`usage-event-${index}`),
              dedupKey: DedupKey.make(`usage-dedup-${index}`),
            }),
          });
          const runId = RunId.make(`usage-run-${index}`);
          yield* store.recordAndClaim(submission, runId);
          const started = yield* store.beginAttempt(
            runId,
            WorkerName.make("local"),
            "local",
            Option.none(),
          );
          assert(started._tag === "AttemptStarted");
          const attemptId = started.execution.attempt.id;
          const parent = ParentSession.make({
            id: AgentSessionId.make("usage-parent"),
            agent: testAgent.name,
            brain: testAgent.brain,
          });
          const child = ChildSession.make({
            id: AgentSessionId.make("usage-child"),
            parentId: parent.id,
            agent: testAgent.name,
            brain: testAgent.brain,
          });
          const logLevels: Array<string> = [];
          const logger = Logger.make<unknown, void>(({ logLevel }) => {
            logLevels.push(logLevel);
          });
          const logging = Logger.layer([logger]);
          const events = [
            SessionTokensUpdated.make({ session: parent, totalTokens: TokenCount.make(100) }),
            SessionTokensUpdated.make({
              session: child,
              totalTokens: TokenCount.make(40),
              costUsd: Option.some(UsdAmount.make(0.4)),
            }),
            TextOutput.make({ session: parent, text: "Delegated the fix." }),
            SessionTokensUpdated.make({ session: parent, totalTokens: TokenCount.make(250) }),
            SessionTokensUpdated.make({
              session: child,
              totalTokens: TokenCount.make(90),
              costUsd: Option.some(UsdAmount.make(1.25)),
            }),
            // A lower report after a higher one never lowers the session's usage.
            SessionTokensUpdated.make({ session: parent, totalTokens: TokenCount.make(200) }),
            SessionTokensUpdated.make({
              session: child,
              totalTokens: TokenCount.make(90),
              costUsd: Option.some(UsdAmount.make(2)),
            }),
          ];
          for (const [index, event] of events.entries()) {
            yield* store
              .appendTranscript(
                "outbound",
                AttemptChannel.OutboundEnvelope.make({
                  version: AttemptChannel.PROTOCOL_VERSION,
                  attemptId,
                  sequence: AttemptChannel.Sequence.make(index + 1),
                  sentAt: DateTime.makeUnsafe("2026-10-20T00:00:00Z"),
                  payload: AttemptChannel.SessionEvent.make({ event }),
                }),
              )
              .pipe(
                Effect.provide(logging),
                Effect.provideService(References.MinimumLogLevel, "Debug"),
              );
          }
          assert.deepStrictEqual(logLevels, ["Debug", "Debug", "Debug", "Debug", "Debug", "Debug"]);
          yield* store.appendTranscript(
            "outbound",
            AttemptChannel.OutboundEnvelope.make({
              version: AttemptChannel.PROTOCOL_VERSION,
              attemptId,
              sequence: AttemptChannel.Sequence.make(1),
              sentAt: DateTime.makeUnsafe("2026-10-21T00:00:00Z"),
              payload: AttemptChannel.SessionEvent.make({
                event: SessionTokensUpdated.make({
                  session: parent,
                  totalTokens: TokenCount.make(999),
                }),
              }),
            }),
          );
          const all = yield* store.transcript(TranscriptAllQuery.make({ attemptId }));
          const highest = new Map<
            AgentSessionId,
            { totalTokens: TokenCount; entry: (typeof all)[number] }
          >();
          for (const entry of all) {
            const payload = entry.envelope.payload;
            if (
              entry.direction !== "outbound" ||
              payload._tag !== "SessionEvent" ||
              payload.event._tag !== "SessionTokensUpdated"
            )
              continue;
            const previous = highest.get(payload.event.session.id);
            if (previous === undefined || previous.totalTokens < payload.event.totalTokens)
              highest.set(payload.event.session.id, {
                totalTokens: payload.event.totalTokens,
                entry,
              });
          }
          const usage = yield* store.transcript(TranscriptUsageQuery.make({ attemptId }));
          assert.deepStrictEqual(
            usage,
            [...highest.values()].map(({ entry }) => entry).sort((a, b) => a.sequence - b.sequence),
          );
          assert.deepStrictEqual(
            usage.map(({ envelope }): readonly [string, number, number | null] | null =>
              envelope.payload._tag === "SessionEvent" &&
              envelope.payload.event._tag === "SessionTokensUpdated"
                ? [
                    envelope.payload.event.session.id,
                    envelope.payload.event.totalTokens,
                    Option.getOrNull(envelope.payload.event.costUsd),
                  ]
                : null,
            ),
            [
              ["usage-parent", 250, null],
              ["usage-child", 90, 1.25],
            ],
          );
          yield* database
            .run(
              sql`CREATE TEMP TRIGGER reject_usage BEFORE UPDATE ON usine_session_usage BEGIN SELECT RAISE(ABORT, 'usage projection rejected'); END`,
            )
            .execute();
          const rejected = yield* store
            .appendTranscript(
              "outbound",
              AttemptChannel.OutboundEnvelope.make({
                version: AttemptChannel.PROTOCOL_VERSION,
                attemptId,
                sequence: AttemptChannel.Sequence.make(events.length + 1),
                sentAt: DateTime.makeUnsafe("2026-10-22T00:00:00Z"),
                payload: AttemptChannel.SessionEvent.make({
                  event: SessionTokensUpdated.make({
                    session: child,
                    totalTokens: TokenCount.make(1000),
                  }),
                }),
              }),
            )
            .pipe(Effect.flip);
          assert.strictEqual(rejected._tag, "EnginePersistenceError");
          const currentTranscript = yield* store.transcript(TranscriptAllQuery.make({ attemptId }));
          assert.deepStrictEqual(currentTranscript, all);
          const nextTranscript = yield* store.transcript(TranscriptUsageQuery.make({ attemptId }));
          assert.deepStrictEqual(nextTranscript, usage);
          yield* database.run(sql`DROP TRIGGER reject_usage`).execute();
        }
      }).pipe(Effect.provide(RunStore.layer.pipe(Layer.provideMerge(localSqliteLayer(directory)))));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.each([3, 5] as const)("reads stored v%s outbound envelopes", (version) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const currentDirectory = yield* fileSystem.makeTempDirectoryScoped({
        directory: sqliteTempDirectory(),
        prefix: "usine-store-protocol-v3-",
      });
      const directory = InstanceDirectory.make(currentDirectory);
      const submission = Submission.make({
        event: Event.make({
          id: EventId.make("protocol-v3-event"),
          dedupKey: DedupKey.make("protocol-v3/event/revision"),
          payload: {},
          receivedAt: DateTime.makeUnsafe("2026-08-25T00:00:00Z"),
        }),
        itemKey: ItemKey.make("protocol-v3-item"),
        loop: LoopName.make("protocol-v3-loop"),
        step: StepName.make("protocol-v3-step"),
        approval: "none",
        repository: RepositoryName.make("basaltbytes/usine"),
        revision: RepositoryRevision.make("protocol-v3-revision"),
        task: AttemptTask.make("Read a durable protocol-v3 transcript"),
        agent: testAgent,
        parentModel: Option.none(),
      });
      const runId = RunId.make("protocol-v3-run");

      yield* Effect.gen(function* () {
        const database = yield* RunDatabase;
        const store = yield* RunStore;
        yield* store.recordAndClaim(submission, runId);
        const started = yield* store.beginAttempt(
          runId,
          WorkerName.make("local"),
          "local",
          Option.none(),
        );
        assert.strictEqual(started._tag, "AttemptStarted");
        if (started._tag !== "AttemptStarted") return;
        const attemptId = started.execution.attempt.id;
        const currentEnvelope = AttemptChannel.OutboundEnvelope.make({
          version: AttemptChannel.PROTOCOL_VERSION,
          attemptId,
          sequence: AttemptChannel.Sequence.make(1),
          sentAt: DateTime.makeUnsafe("2026-08-25T00:00:01Z"),
          payload: AttemptChannel.Interrupted.make(),
        });
        yield* store.appendTranscript("outbound", currentEnvelope);

        const encoded = yield* Schema.encodeEffect(AttemptChannel.Envelope)(currentEnvelope);
        yield* database
          .update(attemptTranscripts)
          .set({ envelope: { ...encoded, version } })
          .where(eq(attemptTranscripts.attemptId, attemptId))
          .execute();

        const transcript = yield* store.transcript(TranscriptAllQuery.make({ attemptId }));
        const entry = transcript[0];
        assert(entry !== undefined);
        assert.strictEqual(entry.envelope.version, version);
        assert.strictEqual(entry.envelope.payload._tag, "Interrupted");
      }).pipe(Effect.provide(RunStore.layer.pipe(Layer.provideMerge(localSqliteLayer(directory)))));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.each([4, 5] as const)("reads stored v%s inbound envelopes", (version) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const currentDirectory = yield* fileSystem.makeTempDirectoryScoped({
        directory: sqliteTempDirectory(),
        prefix: "usine-store-protocol-v4-",
      });
      const directory = InstanceDirectory.make(currentDirectory);
      const submission = Submission.make({
        event: Event.make({
          id: EventId.make("protocol-v4-event"),
          dedupKey: DedupKey.make("protocol-v4/event/revision"),
          payload: {},
          receivedAt: DateTime.makeUnsafe("2026-08-25T00:00:00Z"),
        }),
        itemKey: ItemKey.make("protocol-v4-item"),
        loop: LoopName.make("protocol-v4-loop"),
        step: StepName.make("protocol-v4-step"),
        approval: "none",
        repository: RepositoryName.make("basaltbytes/usine"),
        revision: RepositoryRevision.make("protocol-v4-revision"),
        task: AttemptTask.make("Read a durable protocol-v4 transcript"),
        agent: testAgent,
        parentModel: Option.none(),
      });
      const runId = RunId.make("protocol-v4-run");

      yield* Effect.gen(function* () {
        const database = yield* RunDatabase;
        const store = yield* RunStore;
        yield* store.recordAndClaim(submission, runId);
        const started = yield* store.beginAttempt(
          runId,
          WorkerName.make("local"),
          "local",
          Option.none(),
        );
        assert.strictEqual(started._tag, "AttemptStarted");
        if (started._tag !== "AttemptStarted") return;
        const attemptId = started.execution.attempt.id;
        const currentEnvelope = AttemptChannel.InboundEnvelope.make({
          operator: "operator",
          version: AttemptChannel.PROTOCOL_VERSION,
          attemptId,
          sequence: AttemptChannel.Sequence.make(1),
          sentAt: DateTime.makeUnsafe("2026-08-25T00:00:01Z"),
          target: AttemptChannel.ParentTarget.make(),
          payload: AttemptChannel.Steer.make({ message: "Keep going" }),
        });
        yield* store.appendTranscript("inbound", currentEnvelope);

        // A v4 row has no session target, so remove the field.
        const {
          target: _target,
          operator: _operator,
          ...withoutTarget
        } = yield* Schema.encodeEffect(AttemptChannel.InboundEnvelope)(currentEnvelope);
        yield* database
          .update(attemptTranscripts)
          .set({
            envelope:
              version === 4
                ? { ...withoutTarget, version }
                : {
                    ...(yield* Schema.encodeEffect(AttemptChannel.InboundEnvelope)(
                      currentEnvelope,
                    )),
                    version,
                  },
          })
          .where(eq(attemptTranscripts.attemptId, attemptId))
          .execute();

        const transcript = yield* store.transcript(TranscriptAllQuery.make({ attemptId }));
        const entry = transcript[0];
        assert(entry !== undefined);
        assert.strictEqual(entry.envelope.version, version);
        if (entry.envelope._tag === "InboundEnvelope" && entry.envelope.version === 5) {
          assert.strictEqual(entry.envelope.operator, "operator");
          assert.strictEqual(entry.envelope.target._tag, "Parent");
        }
        assert.strictEqual(entry.envelope.payload._tag, "Steer");
      }).pipe(Effect.provide(RunStore.layer.pipe(Layer.provideMerge(localSqliteLayer(directory)))));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
