import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  AttemptChannel,
  AttemptFailure,
  Event,
  Item,
  Loop,
  Repository,
  Run,
  Step,
  Worker,
} from "@usine/core";
import { DateTime, Effect, FileSystem, Option } from "effect";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { localSqliteLayer } from "../src/database/local-sqlite.ts";
import { InstanceDirectory, Submission } from "../src/model.ts";
import { RunStore } from "../src/store/store.ts";

const initialMigration = fileURLToPath(
  new URL("../drizzle/20260825055549_initial_runtime/migration.sql", import.meta.url),
);

describe("run store", () => {
  it.live("commits the failed state with the capped Attempt", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-store-" }),
      );
      const event = new Event.Event({
        id: Event.EventId.make("store-event"),
        dedupKey: Event.DedupKey.make("store/event/revision"),
        payload: {},
        receivedAt: DateTime.makeUnsafe("2026-08-25T00:00:00Z"),
      });
      const submission = new Submission({
        event,
        itemKey: Item.ItemKey.make("store-item"),
        loop: Loop.LoopName.make("store-loop"),
        step: Step.StepName.make("store-step"),
        approval: "none",
        repository: Repository.Name.make("basaltbytes/usine"),
        revision: Repository.Revision.make("store-revision"),
        task: AttemptChannel.Task.make("Run the store test"),
      });
      const runId = Run.RunId.make("store-run");
      const failure = new AttemptFailure.InfraFailure({
        message: "offline",
        cause: new Error("offline"),
      });

      yield* Effect.gen(function* () {
        const store = yield* RunStore;
        yield* store.recordAndClaim(submission, runId);
        for (let number = 1; number <= 3; number += 1) {
          const started = yield* store.beginAttempt(runId, Worker.Name.make("local"));
          assert.strictEqual(started._tag, "AttemptStarted");
          if (started._tag !== "AttemptStarted") return;
          assert.strictEqual(
            yield* store.failAttempt(started.execution.attempt, failure),
            number < 3,
          );
        }
        const snapshot = yield* store.snapshot(runId);
        assert.strictEqual(snapshot.run.state._tag, "Failed");
        assert.strictEqual(snapshot.attempts.length, 3);
        assert(snapshot.attempts.every((attempt) => Option.isSome(attempt.outcome)));
      }).pipe(Effect.provide(RunStore.layer), Effect.provide(localSqliteLayer(directory)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("migrates legacy Step results into structured results", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-store-migration-" }),
      );
      const runtimeDirectory = `${directory}/.usine`;
      yield* fileSystem.makeDirectory(runtimeDirectory, { recursive: true });

      const database = new DatabaseSync(`${runtimeDirectory}/runtime.sqlite`);
      const migration = yield* fileSystem.readFileString(initialMigration);
      for (const statement of migration.split("--> statement-breakpoint")) {
        database.exec(statement);
      }
      database.exec(`
        CREATE TABLE usine_migrations (
          id INTEGER PRIMARY KEY,
          hash TEXT NOT NULL,
          created_at NUMERIC,
          name TEXT,
          applied_at TEXT
        );
      `);
      database
        .prepare(
          "INSERT INTO usine_migrations (hash, created_at, name, applied_at) VALUES (?, ?, ?, ?)",
        )
        .run("legacy", 1_756_099_149_000, "20260825055549_initial_runtime", "2026-08-25");
      database.exec(`
        INSERT INTO usine_events VALUES (
          'legacy-event', 'legacy/item/main', '{}', '2026-08-25T00:00:00.000Z'
        );
        INSERT INTO usine_trigger_events VALUES (
          'legacy-event', 'legacy-item', 'legacy-loop', 'legacy-step', 'none'
        );
        INSERT INTO usine_runs VALUES (
          'legacy-run', 'legacy-event', 'legacy-loop', '{"_tag":"Succeeded"}',
          '2026-08-25T00:00:00.000Z'
        );
        INSERT INTO usine_steps VALUES ('legacy-run', 'legacy-step', 'legacy result');
        INSERT INTO usine_attempts VALUES (
          'legacy-attempt', 'legacy-run', 'legacy-step', 1,
          '2026-08-25T00:00:00.000Z', NULL
        );
      `);
      database.close();

      yield* Effect.gen(function* () {
        const store = yield* RunStore;
        const snapshot = yield* store.snapshot(Run.RunId.make("legacy-run"));
        assert(Option.isSome(snapshot.step.result));
        assert.strictEqual(snapshot.step.result.value.message, "legacy result");
        assert.deepStrictEqual(snapshot.step.result.value.facts, []);
        assert.strictEqual(snapshot.repository, "unknown/unknown");
        assert.strictEqual(snapshot.revision, "HEAD");
        assert.strictEqual(snapshot.attempts[0]?.worker, "local");
      }).pipe(Effect.provide(RunStore.layer), Effect.provide(localSqliteLayer(directory)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
