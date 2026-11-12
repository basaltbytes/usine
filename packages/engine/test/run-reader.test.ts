import { sqliteTempDirectory } from "../../../tooling/test/sqlite.mts";
import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { assert, describe, it } from "@effect/vitest";
import { Agent, AgentName, AgentPersona } from "@usine/core/agent";
import { Harness, BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AttemptTask } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { BlockedFailure, type AttemptFailure } from "@usine/core/attempt/failure";
import { DedupKey, Event, EventId } from "@usine/core/event";
import { InstanceDirectory } from "@usine/core/instance";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { CommitSha, RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { TestClock } from "effect/testing";
import { ciFixDedupKey } from "../src/engine/submission.ts";
import { StepName } from "@usine/core/step";
import { WorkerName } from "@usine/core/worker";
import { EffectLogger } from "drizzle-orm/effect-core";
import * as SQLiteDrizzle from "drizzle-orm/effect-sqlite-node";
import { DateTime, Effect, FileSystem, Layer, Option, Path, Queue, Ref } from "effect";
import { RunDatabase } from "../src/database/database.ts";
import { layer } from "../src/database/local-sqlite.ts";
import { transcriptCodecLayer } from "../src/database/transcript-codec.ts";
import { RunEngine, Submission } from "../src/engine/engine.ts";
import { CiFixRun, RunReader, WorkerAttempts } from "../src/run-reader/run-reader.ts";
import { CompletionCheck } from "../src/completion-check.ts";
import { StepExecutor } from "../src/step-executor.ts";
import { savedSettings, TriggerCondition, TriggerRecheck } from "../src/trigger-condition.ts";
import {
  type AttemptPlan,
  engineLayer,
  executorLayer,
  submission as supportSubmission,
  waitFor,
  withInstance,
} from "./support.ts";

describe("Run evidence reader", () => {
  it.live("keeps the Attempt's selected model consistent with its transcript while it starts", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const currentDirectory = yield* fileSystem.makeTempDirectoryScoped({
        directory: sqliteTempDirectory(),
        prefix: "usine-evidence-reader-",
      });
      const directory = InstanceDirectory.make(currentDirectory);
      const now = DateTime.makeUnsafe("2026-09-06T00:00:00Z");
      const model = ModelId.make("evidence-model");
      const starts = yield* Queue.unbounded<Effect.Effect<void, AttemptFailure>>();
      const executor = Layer.succeed(StepExecutor)({
        workers: Effect.succeed([WorkerName.make("local")]),
        isLive: () => Effect.succeed(false),
        outcome: () => Effect.succeedNone,
        recover: () => Effect.succeed("found" as const),
        intervene: () => Effect.void,
        occupy: (worker) => Effect.succeed({ worker, release: Effect.void }),
        sweep: Effect.void,
        discard: () => Effect.void,
        reserve: () => Effect.succeed({ worker: WorkerName.make("local"), release: Effect.void }),
        interrupt: () => Effect.void,
        execute: (execution, io) =>
          Queue.offer(
            starts,
            io.append(
              "outbound",
              AttemptChannel.OutboundEnvelope.make({
                version: AttemptChannel.PROTOCOL_VERSION,
                attemptId: execution.attempt.id,
                sequence: AttemptChannel.Sequence.make(1),
                sentAt: now,
                payload: AttemptChannel.Started.make({ parentModel: Option.some(model) }),
              }),
            ),
          ).pipe(Effect.andThen(Effect.never)),
      });
      const writer = layer(directory).pipe(
        Layer.provide(executor),
        Layer.provide(
          Layer.succeed(TriggerCondition)({
            recheck: (submission) =>
              Effect.succeed(TriggerRecheck.Matches({ settings: savedSettings(submission) })),
          }),
        ),
        Layer.provide(CompletionCheck.unverified),
      );
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const submission = {
          loop: LoopName.make("develop"),
          step: StepName.make("run"),
          approval: "none" as const,
          repository: RepositoryName.make("basaltbytes/usine"),
          revision: RepositoryRevision.make("main"),
          task: AttemptTask.make("Retain a consistent record."),
          agent: Agent.make({
            name: AgentName.make("developer"),
            brain: BrainSpec.make({ harness: Harness.make("codex"), model, effort: "high" }),
            parentModel: Option.none(),
            parentEffort: Option.none(),
            persona: AgentPersona.make("Implement the task."),
          }),
          parentModel: Option.none(),
        };
        const observedStarts = new Set<boolean>();
        // Delivers `Started` at each database operation boundary in turn. The sweep ends at the
        // first boundary not reached, so it doesn't depend on the query structure.
        for (let boundary = 1; ; boundary += 1) {
          const submitted = yield* engine.submit(
            Submission.make({
              ...submission,
              itemKey: ItemKey.make(`evidence-item-${boundary}`),
              event: Event.make({
                id: EventId.make(`evidence-event-${boundary}`),
                dedupKey: DedupKey.make(`evidence/event/${boundary}`),
                payload: {},
                receivedAt: now,
              }),
            }),
          );
          assert(submitted._tag === "Claimed");
          const start = yield* Queue.take(starts);
          let operations = 0;
          const logger = Layer.succeed(EffectLogger)({
            logQuery: () =>
              Effect.gen(function* () {
                operations += 1;
                if (operations === boundary) yield* start;
              }).pipe(Effect.orDie),
          });
          const readConnection = SqliteClient.layer({
            filename: path.join(directory, ".usine", "runtime.sqlite"),
            readonly: true,
            disableWAL: true,
          });
          const database = Layer.effect(
            RunDatabase,
            SQLiteDrizzle.make().pipe(
              Effect.provide(logger.pipe(Layer.provideMerge(SQLiteDrizzle.DefaultServices))),
            ),
          ).pipe(Layer.provide(readConnection));
          // The engine already provides RunReader; keep this reader on its own
          // connection instead of reusing the engine layer's memoized instance.
          const reader = RunReader.layer.pipe(
            Layer.provide(Layer.merge(database, transcriptCodecLayer)),
            Layer.fresh,
          );
          const evidence = yield* Effect.flatMap(RunReader, (reader) =>
            reader.evidence(submitted.runId),
          ).pipe(Effect.provide(reader));

          const attempt = evidence.snapshot.attempts[0];
          assert(attempt !== undefined);
          const includesStarted = evidence.transcript.some(
            ({ envelope }) => envelope.payload._tag === "Started",
          );
          assert.deepStrictEqual(
            attempt.parentModel,
            includesStarted ? Option.some(model) : Option.none(),
          );
          observedStarts.add(includesStarted);
          const current = yield* Effect.flatMap(RunReader, (reader) =>
            reader.evidence(submitted.runId),
          );
          observedStarts.add(
            current.transcript.some(({ envelope }) => envelope.payload._tag === "Started"),
          );
          if (operations < boundary) break;
        }
        assert.sameMembers(
          [...observedStarts],
          [false, true],
          "The fixture must observe evidence both before and after Started",
        );
      }).pipe(Effect.provide(writer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("Loop sightings", () => {
  it.live(
    "name the Run that owns the Item's state, following a reopening, and the Run that suppresses it",
    () =>
      withInstance((directory) =>
        Effect.gen(function* () {
          const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
            BlockedFailure.make({ message: "The baseline gate fails on main." }),
          ]);
          yield* Effect.gen(function* () {
            const engine = yield* RunEngine;
            const reader = yield* RunReader;
            const sightingsOf = (item: string) => reader.sightings([ItemKey.make(item)]);

            const blocked = yield* engine.submit(
              supportSubmission({ number: 1, item: "suppressed" }),
            );
            assert(blocked._tag === "Claimed");
            yield* waitFor(engine, blocked.runId, ({ run }) => run.state._tag === "Failed");
            const [suppressed, ...others] = yield* sightingsOf("suppressed");
            assert.deepStrictEqual(others, []);
            assert.strictEqual(suppressed?.loop, LoopName.make("review"));
            assert.deepStrictEqual(suppressed?.event, Option.some(EventId.make("event-1")));
            assert.deepStrictEqual(suppressed?.run, Option.some(blocked.runId));
            assert.deepStrictEqual(suppressed?.suppressedBy, Option.some(blocked.runId));

            // A canceled Run keeps its Event until the Item comes back to that state,
            // which opens the Event again under a reopening of its own.
            const first = yield* engine.submit(
              supportSubmission({ number: 2, item: "reopened", approval: "required" }),
            );
            assert(first._tag === "Claimed");
            yield* engine.cancel(first.runId);
            const [canceled] = yield* sightingsOf("reopened");
            assert.deepStrictEqual(canceled?.run, Option.some(first.runId));
            yield* engine.submit(
              supportSubmission({ number: 3, item: "reopened", approval: "required" }),
            );
            const back = yield* engine.submit(
              supportSubmission({ number: 2, item: "reopened", approval: "required" }),
            );
            assert(back._tag === "Claimed");
            assert.notStrictEqual(back.runId, first.runId);
            const [reopened] = yield* sightingsOf("reopened");
            assert(reopened !== undefined && Option.isSome(reopened.event));
            assert.notStrictEqual(reopened.event.value, EventId.make("event-2"));
            assert.deepStrictEqual(reopened.run, Option.some(back.runId));
            assert.deepStrictEqual(reopened.suppressedBy, Option.none());

            // A sighting that does not match records no Event.
            yield* engine.revoke(LoopName.make("review"), ItemKey.make("reopened"));
            const [unmatched] = yield* sightingsOf("reopened");
            assert.deepStrictEqual(unmatched?.event, Option.none());
            assert.deepStrictEqual(unmatched?.run, Option.none());
            const currentSightings = yield* sightingsOf("never-seen");
            assert.deepStrictEqual(currentSightings, []);
          }).pipe(Effect.provide(engineLayer(directory, executorLayer(plans))));
        }),
      ),
  );
});

describe("Run Events", () => {
  it.live("read the Event each Run was opened for, once per Run, leaving out unknown Runs", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([]);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const reader = yield* RunReader;
          const first = yield* engine.submit(
            supportSubmission({ number: 1, item: "first", approval: "required" }),
          );
          const second = yield* engine.submit(
            supportSubmission({ number: 2, item: "second", approval: "required" }),
          );
          assert(first._tag === "Claimed" && second._tag === "Claimed");

          const read = yield* reader.events([
            second.runId,
            RunId.make("run-that-does-not-exist"),
            first.runId,
            second.runId,
          ]);
          const byRun = new Map(read.map(({ runId, event }) => [runId, event]));
          assert.strictEqual(read.length, 2);
          assert.deepStrictEqual(byRun.get(first.runId)?.id, EventId.make("event-1"));
          assert.deepStrictEqual(byRun.get(first.runId)?.payload, { revision: 1 });
          assert.deepStrictEqual(byRun.get(second.runId)?.id, EventId.make("event-2"));
          assert.deepStrictEqual(byRun.get(second.runId)?.payload, { revision: 2 });
          const currentEvents = yield* reader.events([]);
          assert.deepStrictEqual(currentEvents, []);
        }).pipe(Effect.provide(engineLayer(directory, executorLayer(plans))));
      }),
    ),
  );
});

it.effect("maps a source Run to its newest admitted CI fix across failed heads", () =>
  withInstance((directory) =>
    Effect.gen(function* () {
      const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([]);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const reader = yield* RunReader;
        const sourceId = RunId.make("source-run");
        const unrelatedId = RunId.make("unrelated-source");
        const fix = (number: number, source: RunId, head: string) => {
          const original = supportSubmission({ number, approval: "required" });
          const failedHead = CommitSha.make(head.repeat(40));
          const key = ciFixDedupKey(source, failedHead);
          return Submission.make({
            ...original,
            event: Event.make({ ...original.event, id: EventId.make(key), dedupKey: key }),
            ciFailureHead: Option.some(failedHead),
          });
        };
        yield* TestClock.setTime(1000);
        const first = yield* engine.submit(
          Submission.make({ ...fix(1, sourceId, "a"), itemKey: ItemKey.make("first-fix") }),
        );
        assert(first._tag === "Claimed");
        assert.deepStrictEqual(
          (yield* reader.ciFixRuns([sourceId])).get(sourceId),
          CiFixRun.make({ runId: first.runId, state: "Waiting" }),
        );
        yield* TestClock.setTime(2000);
        const second = yield* engine.submit(fix(2, sourceId, "b"));
        assert(second._tag === "Claimed");
        yield* TestClock.setTime(3000);
        const unrelated = yield* engine.submit(
          Submission.make({
            ...fix(3, unrelatedId, "c"),
            itemKey: ItemKey.make("other-item"),
          }),
        );
        assert(unrelated._tag === "Claimed");

        const links = yield* reader.ciFixRuns([
          sourceId,
          unrelatedId,
          RunId.make("unknown-source"),
        ]);
        assert.deepStrictEqual(
          links,
          new Map([
            [sourceId, CiFixRun.make({ runId: second.runId, state: "Waiting" })],
            [unrelatedId, CiFixRun.make({ runId: unrelated.runId, state: "Waiting" })],
          ]),
        );
        const unknownSources = Array.from({ length: 1100 }, (_, index) =>
          RunId.make(index.toString(16).padStart(32, "0")),
        );
        const manyLinks = yield* reader.ciFixRuns([
          sourceId,
          ...unknownSources,
          unrelatedId,
          sourceId,
        ]);
        assert.deepStrictEqual(manyLinks, links);
        const empty = yield* reader.ciFixRuns([]);
        assert.deepStrictEqual(empty, new Map());

        // Fixes opened at the same time are ordered by Run ID.
        const tiedSourceId = RunId.make("tied-source");
        yield* TestClock.setTime(4000);
        const tied = yield* Effect.forEach(["d", "e"], (head, index) =>
          engine.submit(
            Submission.make({
              ...fix(4 + index, tiedSourceId, head),
              itemKey: ItemKey.make(`tied-fix-${head}`),
            }),
          ),
        );
        const tiedRunIds = tied.map((result) => {
          assert(result._tag === "Claimed");
          return result.runId;
        });
        const newestTied = [...tiedRunIds].sort().at(-1);
        assert.strictEqual(
          (yield* reader.ciFixRuns([tiedSourceId])).get(tiedSourceId)?.runId,
          newestTied,
        );
        yield* engine.drain;
      }).pipe(Effect.provide(engineLayer(directory, executorLayer(plans))));
    }),
  ),
);

it.live.each(["canceled", "revoked"] as const)(
  "omits a %s CI fix from its source Run's links and links its reopening",
  (state) =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([]);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const reader = yield* RunReader;
          const sourceId = RunId.make("source-with-canceled-fix");
          const original = supportSubmission({ number: 1, approval: "required" });
          const head = CommitSha.make("a".repeat(40));
          const key = ciFixDedupKey(sourceId, head);
          const fix = Submission.make({
            ...original,
            event: Event.make({ ...original.event, id: EventId.make(key), dedupKey: key }),
            ciFailureHead: Option.some(head),
          });
          const admitted = yield* engine.submit(fix);
          assert(admitted._tag === "Claimed");
          yield* waitFor(engine, admitted.runId, ({ run }) => run.state._tag === "Waiting");
          assert.strictEqual(
            (yield* reader.ciFixRuns([sourceId])).get(sourceId)?.runId,
            admitted.runId,
          );

          if (state === "canceled") yield* engine.cancel(admitted.runId);
          else yield* engine.revoke(fix.loop, fix.itemKey);

          const stopped = yield* engine.inspect(admitted.runId);
          assert.strictEqual(stopped.run.state._tag, "Canceled");
          const links = yield* reader.ciFixRuns([sourceId]);
          assert.deepStrictEqual(links, new Map());

          // The Item leaves and comes back to the fix Event, which opens again under a reopening
          // key; its Run is linked.
          if (state === "canceled") yield* engine.revoke(fix.loop, fix.itemKey);
          const reopened = yield* engine.submit(fix);
          assert(reopened._tag === "Claimed");
          assert.notStrictEqual(reopened.runId, admitted.runId);
          yield* waitFor(engine, reopened.runId, ({ run }) => run.state._tag === "Waiting");
          assert.deepStrictEqual(
            (yield* reader.ciFixRuns([sourceId])).get(sourceId),
            CiFixRun.make({ runId: reopened.runId, state: "Waiting" }),
          );
          yield* engine.drain;
        }).pipe(Effect.provide(engineLayer(directory, executorLayer(plans))));
      }),
    ),
);

describe("Attempts by Worker", () => {
  it("counts a Worker whose every Attempt still runs, and refuses more open Attempts than Attempts", () => {
    // A Worker removed by a reload, with its only Attempt still running. If the schema rejected
    // this count, every overview would fail until that Attempt ends.
    const local = WorkerName.make("local");
    assert.doesNotThrow(() => WorkerAttempts.make({ worker: local, attempts: 1, running: 1 }));
    assert.throws(() => WorkerAttempts.make({ worker: local, attempts: 1, running: 2 }));
  });
});
