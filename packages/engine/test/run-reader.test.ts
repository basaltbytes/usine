import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { assert, describe, it } from "@effect/vitest";
import { Agent, AgentName, AgentPersona } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AttemptTask } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { DedupKey, Event, EventId } from "@usine/core/event";
import { InstanceDirectory } from "@usine/core/instance";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { StepName } from "@usine/core/step";
import { StepResult } from "@usine/core/step/result";
import { WorkerName } from "@usine/core/worker";
import { EffectLogger } from "drizzle-orm/effect-core";
import * as SQLiteDrizzle from "drizzle-orm/effect-sqlite-node";
import { DateTime, Effect, FileSystem, Layer, Option, Path, Result } from "effect";
import { RunDatabase } from "../src/database/database.ts";
import { localSqliteLayer } from "../src/database/local-sqlite.ts";
import { Submission } from "../src/engine/submission.ts";
import { RunReader } from "../src/run-reader/run-reader.ts";
import { RunStore } from "../src/store/store.ts";
import { TranscriptAllQuery } from "../src/transcript.ts";

describe("Run evidence reader", () => {
  it.live("keeps one snapshot when another connection completes the Attempt during the read", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-evidence-reader-" }),
      );
      const writer = RunStore.layer.pipe(Layer.provide(localSqliteLayer(directory)));
      yield* Effect.gen(function* () {
        const store = yield* RunStore;
        const now = DateTime.makeUnsafe("2026-09-06T00:00:00Z");
        const model = ModelId.make("evidence-model");
        const runId = RunId.make("evidence-run");
        const submission = new Submission({
          event: new Event({
            id: EventId.make("evidence-event"),
            dedupKey: DedupKey.make("evidence/event/revision"),
            payload: {},
            receivedAt: now,
          }),
          itemKey: ItemKey.make("evidence-item"),
          loop: LoopName.make("develop"),
          step: StepName.make("run"),
          approval: "none",
          repository: RepositoryName.make("basaltbytes/usine"),
          revision: RepositoryRevision.make("main"),
          task: AttemptTask.make("Retain a consistent record."),
          agent: new Agent({
            name: AgentName.make("developer"),
            brain: new BrainSpec({ harness: "codex", model, effort: "high" }),
            parentModel: Option.none(),
            parentEffort: Option.none(),
            persona: AgentPersona.make("Implement the task."),
          }),
          parentModel: Option.none(),
        });
        yield* store.recordAndClaim(submission, runId);
        const started = yield* store.beginAttempt(runId, WorkerName.make("local"));
        assert(started._tag === "AttemptStarted");
        const attempt = started.execution.attempt;
        yield* store.appendTranscript(
          "outbound",
          new AttemptChannel.OutboundEnvelope({
            version: AttemptChannel.PROTOCOL_VERSION,
            attemptId: attempt.id,
            sequence: AttemptChannel.Sequence.make(1),
            sentAt: now,
            payload: new AttemptChannel.Started({ parentModel: model }),
          }),
        );
        const originalSnapshot = yield* store.snapshot(runId);
        const transcriptQuery = new TranscriptAllQuery({ attemptId: attempt.id });
        const originalTranscript = yield* store.transcript(transcriptQuery);
        const result = new StepResult({ message: "Completed during the evidence read", facts: [] });
        let completed = false;
        // Drizzle's logger runs before a query. Commit through the independent WAL
        // writer after the Run snapshot is read, but before its transcript is read.
        const logger = Layer.succeed(EffectLogger)({
          logQuery: (query) =>
            Effect.gen(function* () {
              if (completed || !query.includes('"usine_attempt_transcripts"')) return;
              completed = true;
              yield* store.appendTranscript(
                "outbound",
                new AttemptChannel.OutboundEnvelope({
                  version: AttemptChannel.PROTOCOL_VERSION,
                  attemptId: attempt.id,
                  sequence: AttemptChannel.Sequence.make(2),
                  sentAt: now,
                  payload: new AttemptChannel.Final({ result }),
                }),
              );
              yield* store.finishAttempt(attempt, Result.succeed(result));
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
            Effect.provide(logger),
            Effect.provide(SQLiteDrizzle.DefaultServices),
          ),
        ).pipe(Layer.provide(readConnection));
        const reader = RunReader.layer.pipe(Layer.provide(database));
        const evidence = yield* Effect.flatMap(RunReader, (reader) => reader.evidence(runId)).pipe(
          Effect.provide(reader),
        );

        assert.strictEqual((yield* store.snapshot(runId)).run.state._tag, "Succeeded");
        assert.strictEqual((yield* store.transcript(transcriptQuery)).length, 2);
        assert.deepStrictEqual(evidence.snapshot, originalSnapshot);
        assert.deepStrictEqual(evidence.transcript, originalTranscript);
      }).pipe(Effect.provide(writer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
