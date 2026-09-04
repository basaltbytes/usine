import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Agent, AgentPersona, AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, ParentSession, TextOutput } from "@usine/core/agent/session";
import { AttemptTask } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { InfraFailure } from "@usine/core/attempt/failure";
import { Event, DedupKey, EventId } from "@usine/core/event";
import { ItemKey, ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { StepName } from "@usine/core/step";
import { WorkerName } from "@usine/core/worker";
import { eq } from "drizzle-orm";
import { DateTime, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { RunDatabase } from "../src/database/database.ts";
import { localSqliteLayer } from "../src/database/local-sqlite.ts";
import { attemptTranscripts } from "../src/database/schema.ts";
import { CursorKey, CursorStore } from "../src/cursor/cursor.ts";
import { LoopControl } from "../src/loop-control/loop-control.ts";
import {
  ItemContentHash,
  ItemProjection,
  ItemProjectionSource,
} from "../src/item-projection/model.ts";
import {
  ItemProjectionReader,
  ItemProjectionWriter,
} from "../src/item-projection/item-projection.ts";
import {
  RepositoryLabel,
  RepositoryLabelProjection,
} from "../src/repository-label-projection/model.ts";
import {
  RepositoryLabelProjectionReader,
  RepositoryLabelProjectionWriter,
} from "../src/repository-label-projection/repository-label-projection.ts";
import { Submission } from "../src/engine/submission.ts";
import {
  TranscriptAllQuery,
  TranscriptPageQuery,
  TranscriptSequence,
  TranscriptTailQuery,
} from "../src/transcript.ts";
import { InstanceDirectory } from "@usine/core/instance";
import { RunReader } from "../src/run-reader/run-reader.ts";
import { RunStore } from "../src/store/store.ts";

const testAgent = new Agent({
  name: AgentName.make("developer"),
  brain: new BrainSpec({
    harness: "claude",
    model: ModelId.make("claude-sonnet-4-6"),
    effort: "high",
  }),
  parentModel: Option.none(),
  parentEffort: Option.none(),
  persona: AgentPersona.make("Implement the task."),
});

describe("run store", () => {
  it.live("commits the failed state with the capped Attempt", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-store-" }),
      );
      const event = new Event({
        id: EventId.make("store-event"),
        dedupKey: DedupKey.make("store/event/revision"),
        payload: {},
        receivedAt: DateTime.makeUnsafe("2026-08-25T00:00:00Z"),
      });
      const submission = new Submission({
        event,
        itemKey: ItemKey.make("store-item"),
        loop: LoopName.make("store-loop"),
        step: StepName.make("store-step"),
        approval: "none",
        repository: RepositoryName.make("basaltbytes/usine"),
        revision: RepositoryRevision.make("store-revision"),
        task: AttemptTask.make("Run the store test"),
        agent: testAgent,
        parentModel: Option.none(),
      });
      const runId = RunId.make("store-run");
      const failure = new InfraFailure({
        message: "offline",
        cause: new Error("offline"),
      });

      yield* Effect.gen(function* () {
        const store = yield* RunStore;
        yield* store.recordAndClaim(submission, runId);
        for (let number = 1; number <= 3; number += 1) {
          const started = yield* store.beginAttempt(runId, WorkerName.make("local"));
          assert.strictEqual(started._tag, "AttemptStarted");
          if (started._tag !== "AttemptStarted") return;
          assert.deepStrictEqual(started.execution.attempt.brain, testAgent.brain);
          assert.deepStrictEqual(started.execution.attempt.parentModel, Option.none());
          assert.strictEqual(
            yield* store.failAttempt(started.execution.attempt, failure),
            number < 3,
          );
        }
        const snapshot = yield* store.snapshot(runId);
        assert.strictEqual(snapshot.itemKey, submission.itemKey);
        assert.strictEqual(snapshot.run.state._tag, "Failed");
        assert.strictEqual(snapshot.attempts.length, 3);
        assert(snapshot.attempts.every((attempt) => Option.isSome(attempt.outcome)));
      }).pipe(Effect.provide(RunStore.layer), Effect.provide(localSqliteLayer(directory)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("an approved Run is Queued until its attempt starts", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-store-queued-" }),
      );
      const submission = new Submission({
        event: new Event({
          id: EventId.make("queued-event"),
          dedupKey: DedupKey.make("queued/event/revision"),
          payload: {},
          receivedAt: DateTime.makeUnsafe("2026-09-03T00:00:00Z"),
        }),
        itemKey: ItemKey.make("queued-item"),
        loop: LoopName.make("queued-loop"),
        step: StepName.make("queued-step"),
        approval: "required",
        repository: RepositoryName.make("basaltbytes/usine"),
        revision: RepositoryRevision.make("queued-revision"),
        task: AttemptTask.make("Wait for a worker"),
        agent: testAgent,
        parentModel: Option.none(),
      });
      const approval = new Event({
        id: EventId.make("queued-approval"),
        dedupKey: DedupKey.make("queued/approval"),
        payload: { approved: true },
        receivedAt: DateTime.makeUnsafe("2026-09-03T00:01:00Z"),
      });
      const runId = RunId.make("queued-run");

      yield* Effect.gen(function* () {
        const store = yield* RunStore;
        const state = () => store.snapshot(runId).pipe(Effect.map(({ run }) => run.state._tag));
        yield* store.recordAndClaim(submission, runId);
        yield* store.parkForApproval(runId);
        assert.strictEqual(yield* state(), "Waiting");

        yield* store.approve(runId, approval);
        assert.strictEqual(yield* state(), "Queued");
        // Re-delivery of the same approval is a no-op, not a rejection.
        yield* store.approve(runId, approval);
        assert.strictEqual(yield* state(), "Queued");

        const started = yield* store.beginAttempt(runId, WorkerName.make("local"));
        assert.strictEqual(started._tag, "AttemptStarted");
        assert.strictEqual(yield* state(), "Running");
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
        const started = yield* store.beginAttempt(runId, WorkerName.make("local"));
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

  it.live("reads transcript envelopes persisted under protocol v3", () =>
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
        const started = yield* store.beginAttempt(runId, WorkerName.make("local"));
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
          .set({ envelope: { ...encoded, version: 3 } })
          .where(eq(attemptTranscripts.attemptId, attemptId))
          .execute();

        const transcript = yield* store.transcript(new TranscriptAllQuery({ attemptId }));
        const entry = transcript[0];
        assert(entry !== undefined);
        assert.strictEqual(entry.envelope.version, 3);
        assert.strictEqual(entry.envelope.payload._tag, "Interrupted");
      }).pipe(Effect.provide(RunStore.layer), Effect.provide(localSqliteLayer(directory)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reports a run closed while queued instead of starting an attempt", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-store-closed-" }),
      );
      const submission = new Submission({
        event: new Event({
          id: EventId.make("closed-event"),
          dedupKey: DedupKey.make("closed/event/revision"),
          payload: {},
          receivedAt: DateTime.makeUnsafe("2026-08-25T00:00:00Z"),
        }),
        itemKey: ItemKey.make("closed-item"),
        loop: LoopName.make("closed-loop"),
        step: StepName.make("closed-step"),
        approval: "none",
        repository: RepositoryName.make("basaltbytes/usine"),
        revision: RepositoryRevision.make("closed-revision"),
        task: AttemptTask.make("Close before starting"),
        agent: testAgent,
        parentModel: Option.none(),
      });
      const runId = RunId.make("closed-run");

      yield* Effect.gen(function* () {
        const store = yield* RunStore;
        yield* store.recordAndClaim(submission, runId);
        // With worker capacity, a run routinely closes between claim and begin;
        // that is not a defect.
        const outcome = yield* store.cancel(runId);
        assert.strictEqual(outcome._tag, "Canceled");
        const started = yield* store.beginAttempt(runId, WorkerName.make("local"));
        assert.strictEqual(started._tag, "RunClosed");
        const snapshot = yield* store.snapshot(runId);
        assert.strictEqual(snapshot.attempts.length, 0);
      }).pipe(Effect.provide(RunStore.layer), Effect.provide(localSqliteLayer(directory)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("Item projections", () => {
  it.live("stores the latest polled Item without invalidating unchanged operator reads", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-item-projection-" }),
      );
      const repository = RepositoryName.make("basaltbytes/usine");
      const item = new ItemProjection({
        itemKey: ItemKey.make("github:basaltbytes/usine:33"),
        repository,
        source: ItemProjectionSource.make("issue"),
        number: ItemNumber.make(33),
        contentHash: ItemContentHash.make("content-1"),
        payload: { number: 33, title: "Board lanes" },
      });
      const database = localSqliteLayer(directory);
      const services = Layer.mergeAll(
        ItemProjectionReader.layer,
        ItemProjectionWriter.layer,
        RunReader.layer,
      ).pipe(Layer.provide(database));

      yield* Effect.gen(function* () {
        const reader = yield* ItemProjectionReader;
        const writer = yield* ItemProjectionWriter;
        const runs = yield* RunReader;
        const before = yield* runs.revision();
        assert(Option.isSome(before));

        assert.strictEqual(yield* writer.upsert(item), true);
        const changed = yield* runs.revision();
        assert(Option.isSome(changed));
        assert.strictEqual(changed.value, before.value + 1);
        assert.deepStrictEqual(yield* reader.list(repository, { limit: 10 }), [item]);

        assert.strictEqual(yield* writer.upsert(item), false);
        assert.deepStrictEqual(yield* runs.revision(), changed);
      }).pipe(Effect.provide(services));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("repository label projections", () => {
  it.live("stores the complete catalog and invalidates only changed operator reads", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-label-projection-" }),
      );
      const repository = RepositoryName.make("basaltbytes/usine");
      const projection = new RepositoryLabelProjection({
        repository,
        labels: [
          new RepositoryLabel({
            name: "bug",
            color: Option.some("d73a4a"),
            description: Option.some("Something is broken"),
          }),
          new RepositoryLabel({
            name: "unused-ready-label",
            color: Option.none(),
            description: Option.none(),
          }),
        ],
      });
      const database = localSqliteLayer(directory);
      const services = Layer.mergeAll(
        RepositoryLabelProjectionReader.layer,
        RepositoryLabelProjectionWriter.layer,
        RunReader.layer,
      ).pipe(Layer.provide(database));

      yield* Effect.gen(function* () {
        const reader = yield* RepositoryLabelProjectionReader;
        const writer = yield* RepositoryLabelProjectionWriter;
        const runs = yield* RunReader;
        const before = yield* runs.revision();
        assert(Option.isSome(before));

        assert.strictEqual(yield* writer.replace(projection), true);
        const changed = yield* runs.revision();
        assert(Option.isSome(changed));
        assert.strictEqual(changed.value, before.value + 1);
        assert.deepStrictEqual(yield* reader.get(repository), Option.some(projection));

        assert.strictEqual(yield* writer.replace(projection), false);
        assert.deepStrictEqual(yield* runs.revision(), changed);
      }).pipe(Effect.provide(services));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const TestCursor = Schema.Struct({ etag: Schema.String });
const StricterCursor = Schema.Struct({ watermark: Schema.String });

describe("cursor store", () => {
  it.live("replaces one cursor durably without exposing database rows", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-cursor-" }),
      );
      const key = CursorKey.make("github:basaltbytes/usine");
      const database = localSqliteLayer(directory);

      yield* Effect.gen(function* () {
        const store = yield* CursorStore;
        assert(Option.isNone(yield* store.read(key, TestCursor)));
        yield* store.write(key, TestCursor, { etag: "first" });
        yield* store.write(key, TestCursor, { etag: "second" });
      }).pipe(Effect.provide(CursorStore.layer), Effect.provide(database));

      yield* Effect.gen(function* () {
        const store = yield* CursorStore;
        const restored = yield* store.read(key, TestCursor);
        assert(Option.isSome(restored));
        assert.deepStrictEqual(restored.value, { etag: "second" });
        // A stored value that no longer decodes must read as absent, never
        // fail: losing a cursor is always safe.
        assert(Option.isNone(yield* store.read(key, StricterCursor)));
      }).pipe(Effect.provide(CursorStore.layer), Effect.provide(database));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("Loop runtime state", () => {
  it.live("persists pause without changing authored Loop files", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-loop-runtime-" }),
      );
      const loop = LoopName.make("review");
      const database = localSqliteLayer(directory);

      yield* Effect.gen(function* () {
        const control = yield* LoopControl;
        assert.strictEqual(yield* control.isPaused(loop), false);
        assert.strictEqual((yield* control.pause(loop)).paused, true);
        assert.strictEqual((yield* control.pause(loop)).paused, true);
      }).pipe(Effect.provide(LoopControl.layer), Effect.provide(database));

      yield* Effect.gen(function* () {
        const control = yield* LoopControl;
        assert.strictEqual(yield* control.isPaused(loop), true);
        assert.deepStrictEqual(
          (yield* control.states).map((state) => [state.loop, state.paused]),
          [[loop, true]],
        );
        assert.strictEqual((yield* control.unpause(loop)).paused, false);
      }).pipe(Effect.provide(LoopControl.layer), Effect.provide(database));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
