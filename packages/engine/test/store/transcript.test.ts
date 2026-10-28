import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";

import { ModelId } from "@usine/core/agent/brain";
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

import { Event, DedupKey, EventId } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { StepName } from "@usine/core/step";

import { WorkerName } from "@usine/core/worker";
import { eq } from "drizzle-orm";
import { DateTime, Effect, FileSystem, Option, Schema } from "effect";

import { RunDatabase } from "../../src/database/database.ts";
import { localSqliteLayer } from "../../src/database/local-sqlite.ts";
import { attemptTranscripts } from "../../src/database/schema.ts";

import { Submission } from "../../src/engine/submission.ts";
import {
  TranscriptAllQuery,
  TranscriptPageQuery,
  TranscriptSequence,
  TranscriptTailQuery,
  TranscriptUsageQuery,
  TranscriptWorkerQuery,
} from "../../src/transcript.ts";
import { InstanceDirectory } from "@usine/core/instance";

import { RunStore } from "../../src/store/store.ts";

import { lifecycleSubmission, testAgent } from "./support.ts";
describe("Attempt transcripts", () => {
  it.live(
    "keeps the latest worker notice beyond transcript pages and replaces it on recovery",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = InstanceDirectory.make(
          yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-worker-notice-" }),
        );
        yield* Effect.gen(function* () {
          const store = yield* RunStore;
          const runId = RunId.make("worker-notice-run");
          yield* store.recordAndClaim(lifecycleSubmission, runId);
          const started = yield* store.beginAttempt(
            runId,
            WorkerName.make("remote"),
            Option.none(),
          );
          assert(started._tag === "AttemptStarted");
          const attemptId = started.execution.attempt.id;
          const at = DateTime.makeUnsafe("2026-10-28T00:00:00Z");
          let sequence = 0;
          const append = (payload: AttemptChannel.OutboundPayload) =>
            store.appendTranscript(
              "outbound",
              new AttemptChannel.OutboundEnvelope({
                version: AttemptChannel.PROTOCOL_VERSION,
                attemptId,
                sequence: AttemptChannel.Sequence.make(++sequence),
                sentAt: at,
                payload,
              }),
            );
          const query = new TranscriptWorkerQuery({ attemptId });
          assert.deepStrictEqual(yield* store.transcript(query), []);
          const silent = new AttemptChannel.WorkerUnresponsive({
            worker: WorkerName.make("remote"),
            lastAnsweredAt: at,
            reason: "SSH timed out",
            unansweredProbes: 3,
          });
          yield* append(silent);
          for (let i = 0; i < 205; i++)
            yield* append(new AttemptChannel.Started({ parentModel: ModelId.make("test-model") }));
          assert.deepStrictEqual(
            (yield* store.transcript(query)).map(({ envelope }) => envelope.payload),
            [silent],
          );
          const recovered = new AttemptChannel.WorkerResponsive({
            worker: silent.worker,
            lastAnsweredAt: at,
          });
          yield* append(recovered);
          assert.deepStrictEqual(
            (yield* store.transcript(query)).map(({ envelope }) => envelope.payload),
            [recovered],
          );
          yield* append(silent);
          assert.deepStrictEqual(
            (yield* store.transcript(query)).map(({ envelope }) => envelope.payload),
            [silent],
          );
        }).pipe(Effect.provide(RunStore.layer), Effect.provide(localSqliteLayer(directory)));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("writes the effective parent model back onto the Attempt", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-store-started-" }),
      );
      const submission = new Submission({
        event: new Event({
          id: EventId.make("started-event"),
          dedupKey: DedupKey.make("started/event/revision"),
          payload: {},
          receivedAt: DateTime.makeUnsafe("2026-08-25T00:00:00Z"),
        }),
        itemKey: ItemKey.make("started-item"),
        loop: LoopName.make("started-loop"),
        step: StepName.make("started-step"),
        approval: "none",
        repository: RepositoryName.make("basaltbytes/usine"),
        revision: RepositoryRevision.make("started-revision"),
        task: AttemptTask.make("Record the selected models"),
        agent: testAgent,
        parentModel: Option.none(),
      });
      const runId = RunId.make("started-run");
      const effectiveParentModel = ModelId.make("openai/gpt-5.6-sol");

      yield* Effect.gen(function* () {
        const store = yield* RunStore;
        yield* store.recordAndClaim(submission, runId);
        const started = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
        assert.strictEqual(started._tag, "AttemptStarted");
        if (started._tag !== "AttemptStarted") return;
        const attemptId = started.execution.attempt.id;
        yield* store.appendTranscript(
          "outbound",
          new AttemptChannel.OutboundEnvelope({
            version: AttemptChannel.PROTOCOL_VERSION,
            attemptId,
            sequence: AttemptChannel.Sequence.make(1),
            sentAt: DateTime.makeUnsafe("2026-08-25T00:00:01Z"),
            payload: new AttemptChannel.Started({ parentModel: effectiveParentModel }),
          }),
        );
        const parent = new ParentSession({
          id: AgentSessionId.make("store-parent"),
          agent: testAgent.name,
          brain: testAgent.brain,
        });
        for (const sequence of [2, 3] as const) {
          yield* store.appendTranscript(
            "outbound",
            new AttemptChannel.OutboundEnvelope({
              version: AttemptChannel.PROTOCOL_VERSION,
              attemptId,
              sequence: AttemptChannel.Sequence.make(sequence),
              sentAt: DateTime.makeUnsafe(`2026-08-25T00:00:0${sequence}Z`),
              payload: new AttemptChannel.SessionEvent({
                event: new TextOutput({ session: parent, text: `update ${sequence}` }),
              }),
            }),
          );
        }

        const snapshot = yield* store.snapshot(runId);
        assert.deepStrictEqual(snapshot.attempts[0]?.brain, testAgent.brain);
        assert.deepStrictEqual(
          snapshot.attempts[0]?.parentModel,
          Option.some(effectiveParentModel),
        );
        const all = yield* store.transcript(new TranscriptAllQuery({ attemptId }));
        const first = all[0];
        const last = all[2];
        assert(first !== undefined && last !== undefined);
        assert.deepStrictEqual(
          all.map(({ sequence }) => sequence),
          [1, 2, 3],
        );
        assert.deepStrictEqual(
          (yield* store.transcript(
            new TranscriptTailQuery({ attemptId, after: first.sequence, limit: 1 }),
          )).map(({ sequence }) => sequence),
          [2],
        );
        assert.deepStrictEqual(
          (yield* store.transcript(
            new TranscriptTailQuery({
              attemptId,
              after: TranscriptSequence.make(2),
              limit: 1,
            }),
          )).map(({ sequence }) => sequence),
          [3],
        );
        assert.deepStrictEqual(
          (yield* store.transcript(
            new TranscriptPageQuery({
              attemptId,
              before: Option.none(),
              limit: 2,
            }),
          )).map(({ sequence }) => sequence),
          [2, 3],
        );
        assert.deepStrictEqual(
          (yield* store.transcript(
            new TranscriptPageQuery({
              attemptId,
              before: Option.some(last.sequence),
              limit: 2,
            }),
          )).map(({ sequence }) => sequence),
          [1, 2],
        );
      }).pipe(Effect.provide(RunStore.layer), Effect.provide(localSqliteLayer(directory)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reads each session's highest token report, wherever it sits in the transcript", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-store-usage-" }),
      );
      const runId = RunId.make("usage-run");
      yield* Effect.gen(function* () {
        const store = yield* RunStore;
        yield* store.recordAndClaim(lifecycleSubmission, runId);
        const started = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
        assert(started._tag === "AttemptStarted");
        const attemptId = started.execution.attempt.id;
        const parent = new ParentSession({
          id: AgentSessionId.make("usage-parent"),
          agent: testAgent.name,
          brain: testAgent.brain,
        });
        const child = new ChildSession({
          id: AgentSessionId.make("usage-child"),
          parentId: parent.id,
          agent: testAgent.name,
          brain: testAgent.brain,
        });
        const events = [
          new SessionTokensUpdated({ session: parent, totalTokens: TokenCount.make(100) }),
          new SessionTokensUpdated({
            session: child,
            totalTokens: TokenCount.make(40),
            costUsd: Option.some(UsdAmount.make(0.4)),
          }),
          new TextOutput({ session: parent, text: "Delegated the fix." }),
          new SessionTokensUpdated({ session: parent, totalTokens: TokenCount.make(250) }),
          new SessionTokensUpdated({
            session: child,
            totalTokens: TokenCount.make(90),
            costUsd: Option.some(UsdAmount.make(1.25)),
          }),
          // A lower report after a higher one never lowers the session's usage.
          new SessionTokensUpdated({ session: parent, totalTokens: TokenCount.make(200) }),
        ];
        for (const [index, event] of events.entries()) {
          yield* store.appendTranscript(
            "outbound",
            new AttemptChannel.OutboundEnvelope({
              version: AttemptChannel.PROTOCOL_VERSION,
              attemptId,
              sequence: AttemptChannel.Sequence.make(index + 1),
              sentAt: DateTime.makeUnsafe("2026-10-20T00:00:00Z"),
              payload: new AttemptChannel.SessionEvent({ event }),
            }),
          );
        }
        const usage = yield* store.transcript(new TranscriptUsageQuery({ attemptId }));
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
      }).pipe(Effect.provide(RunStore.layer), Effect.provide(localSqliteLayer(directory)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.each([3, 5] as const)("reads stored v%s outbound envelopes", (version) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-store-protocol-v3-" }),
      );
      const submission = new Submission({
        event: new Event({
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
        const started = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
        assert.strictEqual(started._tag, "AttemptStarted");
        if (started._tag !== "AttemptStarted") return;
        const attemptId = started.execution.attempt.id;
        const currentEnvelope = new AttemptChannel.OutboundEnvelope({
          version: AttemptChannel.PROTOCOL_VERSION,
          attemptId,
          sequence: AttemptChannel.Sequence.make(1),
          sentAt: DateTime.makeUnsafe("2026-08-25T00:00:01Z"),
          payload: new AttemptChannel.Interrupted(),
        });
        yield* store.appendTranscript("outbound", currentEnvelope);

        const encoded = Schema.encodeSync(AttemptChannel.Envelope)(currentEnvelope);
        yield* database
          .update(attemptTranscripts)
          .set({ envelope: { ...encoded, version } })
          .where(eq(attemptTranscripts.attemptId, attemptId))
          .execute();

        const transcript = yield* store.transcript(new TranscriptAllQuery({ attemptId }));
        const entry = transcript[0];
        assert(entry !== undefined);
        assert.strictEqual(entry.envelope.version, version);
        assert.strictEqual(entry.envelope.payload._tag, "Interrupted");
      }).pipe(Effect.provide(RunStore.layer), Effect.provide(localSqliteLayer(directory)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.each([4, 5] as const)("reads stored v%s inbound envelopes", (version) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-store-protocol-v4-" }),
      );
      const submission = new Submission({
        event: new Event({
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
        const started = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
        assert.strictEqual(started._tag, "AttemptStarted");
        if (started._tag !== "AttemptStarted") return;
        const attemptId = started.execution.attempt.id;
        const currentEnvelope = new AttemptChannel.InboundEnvelope({
          operator: "operator",
          version: AttemptChannel.PROTOCOL_VERSION,
          attemptId,
          sequence: AttemptChannel.Sequence.make(1),
          sentAt: DateTime.makeUnsafe("2026-08-25T00:00:01Z"),
          target: new AttemptChannel.ParentTarget(),
          payload: new AttemptChannel.Steer({ message: "Keep going" }),
        });
        yield* store.appendTranscript("inbound", currentEnvelope);

        // A v4 row has no session target, so remove the field.
        const {
          target: _target,
          operator: _operator,
          ...withoutTarget
        } = Schema.encodeSync(AttemptChannel.InboundEnvelope)(currentEnvelope);
        yield* database
          .update(attemptTranscripts)
          .set({
            envelope:
              version === 4
                ? { ...withoutTarget, version }
                : {
                    ...Schema.encodeSync(AttemptChannel.InboundEnvelope)(currentEnvelope),
                    version,
                  },
          })
          .where(eq(attemptTranscripts.attemptId, attemptId))
          .execute();

        const transcript = yield* store.transcript(new TranscriptAllQuery({ attemptId }));
        const entry = transcript[0];
        assert(entry !== undefined);
        assert.strictEqual(entry.envelope.version, version);
        if (entry.envelope._tag === "InboundEnvelope" && entry.envelope.version === 5) {
          assert.strictEqual(entry.envelope.operator, "operator");
          assert.strictEqual(entry.envelope.target._tag, "Parent");
        }
        assert.strictEqual(entry.envelope.payload._tag, "Steer");
      }).pipe(Effect.provide(RunStore.layer), Effect.provide(localSqliteLayer(directory)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
