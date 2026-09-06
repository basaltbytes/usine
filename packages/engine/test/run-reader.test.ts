import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { assert, describe, it } from "@effect/vitest";
import { Agent, AgentName, AgentPersona } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AttemptTask } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import type { AttemptFailure } from "@usine/core/attempt/failure";
import { DedupKey, Event, EventId } from "@usine/core/event";
import { InstanceDirectory } from "@usine/core/instance";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { StepName } from "@usine/core/step";
import { WorkerName } from "@usine/core/worker";
import { EffectLogger } from "drizzle-orm/effect-core";
import * as SQLiteDrizzle from "drizzle-orm/effect-sqlite-node";
import { DateTime, Effect, FileSystem, Layer, Option, Path, Queue } from "effect";
import { RunDatabase } from "../src/database/database.ts";
import { layer } from "../src/database/local-sqlite.ts";
import { RunEngine, Submission } from "../src/engine/engine.ts";
import { RunReader } from "../src/run-reader/run-reader.ts";
import { StepExecutor } from "../src/step-executor.ts";

describe("Run evidence reader", () => {
  it.live("keeps the Attempt's selected model consistent with its transcript while it starts", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-evidence-reader-" }),
      );
      const now = DateTime.makeUnsafe("2026-09-06T00:00:00Z");
      const model = ModelId.make("evidence-model");
      const starts = yield* Queue.unbounded<Effect.Effect<void, AttemptFailure>>();
      const executor = Layer.succeed(StepExecutor)({
        reserve: () => Effect.succeed({ worker: WorkerName.make("local"), release: Effect.void }),
        interrupt: () => Effect.void,
        execute: (execution, io) =>
          Queue.offer(
            starts,
            io.append(
              "outbound",
              new AttemptChannel.OutboundEnvelope({
                version: AttemptChannel.PROTOCOL_VERSION,
                attemptId: execution.attempt.id,
                sequence: AttemptChannel.Sequence.make(1),
                sentAt: now,
                payload: new AttemptChannel.Started({ parentModel: model }),
              }),
            ),
          ).pipe(Effect.andThen(Effect.never)),
      });
      const writer = layer(directory).pipe(Layer.provide(executor));
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const submission = {
          loop: LoopName.make("develop"),
          step: StepName.make("run"),
          approval: "none" as const,
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
        };
        const observedStarts = new Set<boolean>();
        // Try the Started arrival at every database-operation boundary. The
        // logger schedules arrivals without inspecting SQL or fixing its shape;
        // the first unreached boundary ends the sweep as query structure changes.
        for (let boundary = 1; ; boundary += 1) {
          const submitted = yield* engine.submit(
            new Submission({
              ...submission,
              itemKey: ItemKey.make(`evidence-item-${boundary}`),
              event: new Event({
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
              Effect.provide(logger),
              Effect.provide(SQLiteDrizzle.DefaultServices),
            ),
          ).pipe(Layer.provide(readConnection));
          // The engine already provides RunReader; keep this reader on its own
          // connection instead of reusing the engine layer's memoized instance.
          const reader = RunReader.layer.pipe(Layer.provide(database), Layer.fresh);
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
