import { Schedule, DateTime, Effect, Layer, Option, Schema, FileSystem } from "effect";
import { sqliteTempDirectory } from "../../../tooling/test/sqlite.mts";
// The Node process boundary uses native process handles and synchronous subprocess operations.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawnSync } from "node:child_process";
// Synchronous Node path callbacks retain the host platform’s path semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join, dirname, basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { NodeServices, NodeFileSystem } from "@effect/platform-node";
import { Agent, AgentName, AgentPersona } from "@usine/core/agent";
import { Harness, BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, ParentSession, TextOutput } from "@usine/core/agent/session";
import { AttemptTask } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AgentFailure } from "@usine/core/attempt/failure";
import { DedupKey, Event, EventId } from "@usine/core/event";
import { InstanceDirectory } from "@usine/core/instance";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { StepName } from "@usine/core/step";
import { StepResult } from "@usine/core/step/result";
import { WorkerName } from "@usine/core/worker";
import { RunEngine, Submission } from "@usine/engine/engine";
import { layer } from "@usine/engine/local-sqlite";
import { RunReader } from "@usine/engine/run-reader";
import { StepExecutor } from "@usine/engine/step-executor";
import { TriggerCondition } from "@usine/engine/trigger-condition";
import { TranscriptAllQuery } from "@usine/engine/transcript";

import { assert, describe, expect, it } from "@effect/vitest";
import { RunEvidenceFromJson } from "../src/export-run.ts";

const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const now = DateTime.makeUnsafe("2026-09-06T00:00:00Z");
const brain = BrainSpec.make({
  harness: Harness.make("codex"),
  model: ModelId.make("test-model"),
  effort: "high",
});
const agent = Agent.make({
  name: AgentName.make("developer"),
  brain,
  parentModel: Option.none(),
  parentEffort: Option.none(),
  persona: AgentPersona.make("Implement the issue."),
});
const parent = ParentSession.make({ id: AgentSessionId.make("parent"), agent: agent.name, brain });
const result = StepResult.make({ message: "Evidence retained", facts: [] });

const executor = Layer.succeed(StepExecutor)({
  workers: Effect.succeed([WorkerName.make("local")]),
  isLive: () => Effect.succeed(false),
  outcome: () => Effect.succeedNone,
  recover: () => Effect.void,
  intervene: () => Effect.void,
  occupy: (worker) => Effect.succeed({ worker, release: Effect.void }),
  sweep: Effect.void,
  discard: () => Effect.void,
  reserve: () => Effect.succeed({ worker: WorkerName.make("local"), release: Effect.void }),
  interrupt: () => Effect.void,
  execute: (execution, io) =>
    Effect.gen(function* () {
      const rows = execution.attempt.number === 1 ? 502 : 2;
      for (let sequence = 1; sequence <= rows; sequence += 1) {
        yield* io.append(
          "outbound",
          AttemptChannel.OutboundEnvelope.make({
            version: AttemptChannel.PROTOCOL_VERSION,
            attemptId: execution.attempt.id,
            sequence: AttemptChannel.Sequence.make(sequence),
            sentAt: now,
            payload:
              sequence === 1
                ? AttemptChannel.Started.make({ parentModel: ModelId.make("selected-parent") })
                : AttemptChannel.SessionEvent.make({
                    event: TextOutput.make({ session: parent, text: `row ${sequence}` }),
                  }),
          }),
        );
      }
      if (execution.attempt.number === 1)
        return yield* AgentFailure.make({ message: "Retry explicitly" });
      return result;
    }),
});

const settle = (engine: RunEngine["Service"], runId: RunId) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 500; tries += 1) {
      const snapshot = yield* engine.inspect(runId);
      if (snapshot.run.state._tag === "Failed" || snapshot.run.state._tag === "Succeeded")
        return snapshot;
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die("The evidence fixture Run did not settle");
  });

const seed = (directory: string) =>
  Effect.gen(function* () {
    const engine = yield* RunEngine;
    const submission = Submission.make({
      event: Event.make({
        id: EventId.make("evidence"),
        dedupKey: DedupKey.make("evidence"),
        payload: { number: 74 },
        receivedAt: now,
      }),
      itemKey: ItemKey.make("github:basaltbytes/usine:74"),
      loop: LoopName.make("develop"),
      step: StepName.make("run"),
      approval: "none",
      repository: RepositoryName.make("basaltbytes/usine"),
      revision: RepositoryRevision.make("main"),
      task: AttemptTask.make("Save all evidence."),
      agent,
      parentModel: Option.none(),
    });
    const submitted = yield* engine.submit(submission);
    assert(submitted._tag === "Claimed");
    const runId = submitted.runId;

    assert.strictEqual((yield* settle(engine, runId)).run.state._tag, "Failed");
    yield* engine.retry(runId);
    const snapshot = yield* settle(engine, runId);
    assert.strictEqual(snapshot.run.state._tag, "Succeeded");
    const reader = yield* RunReader;

    const transcript = (yield* Effect.forEach(snapshot.attempts, ({ id }) =>
      reader.transcript(TranscriptAllQuery.make({ attemptId: id })),
    )).flat();
    const waiting = yield* engine.submit(
      Submission.make({
        ...submission,
        event: Event.make({
          ...submission.event,
          id: EventId.make("waiting"),
          dedupKey: DedupKey.make("waiting"),
        }),
        itemKey: ItemKey.make("github:basaltbytes/usine:75"),
        approval: "required",
      }),
    );
    assert(waiting._tag === "Claimed");
    return { snapshot, transcript, waitingSnapshot: yield* reader.inspect(waiting.runId) };
  }).pipe(
    Effect.provide(
      layer(InstanceDirectory.make(directory)).pipe(
        Layer.provide(executor),
        Layer.provide(
          Layer.succeed(TriggerCondition)({ recheck: () => Effect.succeed("matches") }),
        ),
      ),
    ),
  );

const runCli = (directory: string, args: ReadonlyArray<string>) =>
  spawnSync(process.execPath, [cli, ...args], {
    cwd: directory,
    encoding: "utf8",
    timeout: 15_000,
  });

const directoryFixture = Effect.gen(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
      fileSystem.makeTempDirectory({
        directory: dirname(join(sqliteTempDirectory(), "usine-export-")),
        prefix: basename(join(sqliteTempDirectory(), "usine-export-")),
      }),
    ),
    (directory) =>
      Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem
          .remove(directory, {
            recursive: true,
            force: true,
          })
          .pipe(Effect.retry({ times: 5, schedule: Schedule.spaced(100) })),
      ).pipe(Effect.orDie),
  );
  return directory;
});

describe("Run evidence export", { timeout: 30_000 }, () => {
  it.live("exports complete evidence for every Attempt beyond the UI page", () =>
    Effect.gen(function* () {
      const directory = yield* directoryFixture;
      const saved = yield* seed(directory).pipe(Effect.provide(NodeServices.layer));
      const runId = saved.snapshot.run.id;
      const exported = runCli(directory, ["export-run", runId]);
      assert.strictEqual(exported.status, 0, exported.stderr);
      const output = join(directory, `run-${encodeURIComponent(runId)}.json`);
      const awaited1 = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.readFileString(output),
      );
      const evidence = yield* Schema.decodeEffect(RunEvidenceFromJson)(awaited1);

      assert.strictEqual(evidence.version, 1);
      assert.deepStrictEqual(evidence.snapshot, saved.snapshot);
      assert.deepStrictEqual(evidence.transcript, saved.transcript);
      assert.strictEqual(evidence.snapshot.attempts.length, 2);
      assert.strictEqual(evidence.transcript.length, 504);
      assert.strictEqual(
        (yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.stat(output)))
          .mode & 0o777,
        0o600,
      );
      assert.include(exported.stdout, output);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.live(
    "backs up live WAL state and exports the restored Run with all Attempts and transcripts",
    () =>
      Effect.gen(function* () {
        const directory = yield* directoryFixture;
        const saved = yield* seed(directory).pipe(Effect.provide(NodeServices.layer));
        const restored = join(directory, "restored");
        yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.makeDirectory(join(restored, ".usine"), { recursive: true }),
        );
        const output = join(restored, ".usine", "runtime.sqlite");
        const writer = new DatabaseSync(join(directory, ".usine", "runtime.sqlite"));
        try {
          writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
          writer.exec("CREATE TABLE backup_marker (value TEXT)");
          writer.exec("INSERT INTO backup_marker VALUES ('committed WAL evidence')");
          writer.exec("BEGIN IMMEDIATE; INSERT INTO backup_marker VALUES ('uncommitted')");
          const backedUp = runCli(directory, ["backup", output]);
          assert.strictEqual(backedUp.status, 0, backedUp.stderr);
          assert.include(backedUp.stdout, output);
          assert.strictEqual(
            (yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.stat(output)))
              .mode & 0o777,
            0o600,
          );
          const copy = new DatabaseSync(output, { readOnly: true });
          try {
            assert.deepStrictEqual(
              copy
                .prepare("SELECT value FROM backup_marker")
                .all()
                .map((row) => row.value),
              ["committed WAL evidence"],
            );
            assert.strictEqual(copy.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
          } finally {
            copy.close();
          }
          writer.exec("COMMIT; INSERT INTO backup_marker VALUES ('after backup')");
          assert.strictEqual(writer.prepare("SELECT count(*) AS n FROM backup_marker").get()?.n, 3);
        } finally {
          writer.close();
        }
        const exported = runCli(restored, ["export-run", saved.snapshot.run.id]);
        assert.strictEqual(exported.status, 0, exported.stderr);
        const awaited2 = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.readFileString(
            join(restored, `run-${encodeURIComponent(saved.snapshot.run.id)}.json`),
          ),
        );
        const evidence = yield* Schema.decodeEffect(RunEvidenceFromJson)(awaited2);
        assert.deepStrictEqual(evidence.snapshot, saved.snapshot);
        assert.deepStrictEqual(evidence.transcript, saved.transcript);
        assert.strictEqual(evidence.transcript.length, 504);
      }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.live("exports a Run awaiting approval to the requested destination", () =>
    Effect.gen(function* () {
      const directory = yield* directoryFixture;
      const saved = yield* seed(directory).pipe(Effect.provide(NodeServices.layer));
      const output = join(directory, "waiting.json");
      const exported = runCli(directory, [
        "export-run",
        saved.waitingSnapshot.run.id,
        "--output",
        "waiting.json",
      ]);
      assert.strictEqual(exported.status, 0, exported.stderr);
      const awaited3 = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.readFileString(output),
      );
      const evidence = yield* Schema.decodeEffect(RunEvidenceFromJson)(awaited3);

      assert.deepStrictEqual(evidence.snapshot, saved.waitingSnapshot);
      assert.deepStrictEqual(evidence.snapshot.attempts, []);
      assert.deepStrictEqual(evidence.transcript, []);
      assert.include(exported.stdout, output);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.live("refuses to overwrite an existing evidence file", () =>
    Effect.gen(function* () {
      const directory = yield* directoryFixture;
      const saved = yield* seed(directory).pipe(Effect.provide(NodeServices.layer));
      const output = join(directory, "evidence.json");
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.writeFileString(output, "Previously exported evidence"),
      );
      const exported = runCli(directory, ["export-run", saved.snapshot.run.id, "--output", output]);

      assert.strictEqual(exported.status, 1);
      assert.match(exported.stderr, /write the evidence/i);
      assert.include(exported.stderr, output);
      const actual1 = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.readFileString(output),
      );
      assert.strictEqual(actual1, "Previously exported evidence");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.live("reports a missing Run without publishing a file", () =>
    Effect.gen(function* () {
      const directory = yield* directoryFixture;
      const saved = yield* seed(directory).pipe(Effect.provide(NodeServices.layer));
      const missingId = `${saved.snapshot.run.id}/missing`;
      const output = join(directory, "missing.json");
      const exported = runCli(directory, ["export-run", missingId, "--output", output]);

      assert.strictEqual(exported.status, 1);
      assert.include(exported.stderr, missingId);
      assert.match(exported.stderr, /not found/i);
      {
        const missingFile1 = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.stat(output),
        ).pipe(Effect.flip);
        expect(missingFile1.reason.cause).toMatchObject({
          code: "ENOENT",
        });
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.live("reports an unavailable output directory without creating it", () =>
    Effect.gen(function* () {
      const directory = yield* directoryFixture;
      const saved = yield* seed(directory).pipe(Effect.provide(NodeServices.layer));
      const parent = join(directory, "absent");
      const exported = runCli(directory, [
        "export-run",
        saved.snapshot.run.id,
        "--output",
        join(parent, "evidence.json"),
      ]);

      assert.strictEqual(exported.status, 1);
      assert.match(exported.stderr, /write the evidence/i);
      {
        const missingFile2 = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.stat(parent),
        ).pipe(Effect.flip);
        expect(missingFile2.reason.cause).toMatchObject({
          code: "ENOENT",
        });
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.live("refuses a missing runtime store without creating one", () =>
    Effect.gen(function* () {
      const directory = yield* directoryFixture;
      const exported = runCli(directory, ["export-run", "missing"]);

      assert.strictEqual(exported.status, 1);
      assert.match(exported.stderr, /read the evidence/i);
      {
        const missingFile3 = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.stat(join(directory, ".usine")),
        ).pipe(Effect.flip);
        expect(missingFile3.reason.cause).toMatchObject({ code: "ENOENT" });
      }
      {
        const missingFile4 = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.stat(join(directory, "run-missing.json")),
        ).pipe(Effect.flip);
        expect(missingFile4.reason.cause).toMatchObject({
          code: "ENOENT",
        });
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.live("leaves an unrelated database unchanged when export fails", () =>
    Effect.gen(function* () {
      const directory = yield* directoryFixture;
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.makeDirectory(join(directory, ".usine")),
      );
      const filename = join(directory, ".usine", "runtime.sqlite");
      const database = new DatabaseSync(filename);
      try {
        database.exec("CREATE TABLE original_marker (value TEXT)");
        database.exec("INSERT INTO original_marker VALUES ('preserve me')");
      } finally {
        database.close();
      }
      const original = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.readFile(filename).pipe(Effect.map(Buffer.from)),
      );
      const exported = runCli(directory, ["export-run", "missing"]);

      assert.strictEqual(exported.status, 1);
      assert.match(exported.stderr, /read the evidence/i);
      const actual2 = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.readFile(filename).pipe(Effect.map(Buffer.from)),
      );
      assert.deepStrictEqual(actual2, original);
      {
        const missingFile5 = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.stat(join(directory, "run-missing.json")),
        ).pipe(Effect.flip);
        expect(missingFile5.reason.cause).toMatchObject({
          code: "ENOENT",
        });
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.live.each(["corrupt", "directory"])("reports a %s runtime store as a read failure", (kind) =>
    Effect.gen(function* () {
      const directory = yield* directoryFixture;
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.makeDirectory(join(directory, ".usine")),
      );
      const filename = join(directory, ".usine", "runtime.sqlite");
      if (kind === "directory")
        yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.makeDirectory(filename),
        );
      else
        yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.writeFileString(filename, "not a SQLite database"),
        );
      const exported = runCli(directory, ["export-run", "missing"]);

      assert.strictEqual(exported.status, 1);
      assert.match(exported.stderr, /read the evidence/i);
      {
        const missingFile6 = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.stat(join(directory, "run-missing.json")),
        ).pipe(Effect.flip);
        expect(missingFile6.reason.cause).toMatchObject({
          code: "ENOENT",
        });
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
