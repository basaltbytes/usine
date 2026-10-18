import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { Agent, AgentName, AgentPersona } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
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
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { assert, describe, expect, it } from "vitest";
import { RunEvidenceFromJson } from "../src/export-run.ts";

const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const now = DateTime.makeUnsafe("2026-09-06T00:00:00Z");
const brain = new BrainSpec({
  harness: "codex",
  model: ModelId.make("test-model"),
  effort: "high",
});
const agent = new Agent({
  name: AgentName.make("developer"),
  brain,
  parentModel: Option.none(),
  parentEffort: Option.none(),
  persona: AgentPersona.make("Implement the issue."),
});
const parent = new ParentSession({ id: AgentSessionId.make("parent"), agent: agent.name, brain });
const result = new StepResult({ message: "Evidence retained", facts: [] });

const executor = Layer.succeed(StepExecutor)({
  workers: [WorkerName.make("local")],
  isLive: () => Effect.succeed(false),
  outcome: () => Effect.succeed(Option.none()),
  recover: () => Effect.void,
  intervene: () => Effect.void,
  reserve: () => Effect.succeed({ worker: WorkerName.make("local"), release: Effect.void }),
  interrupt: () => Effect.void,
  execute: (execution, io) =>
    Effect.gen(function* () {
      const rows = execution.attempt.number === 1 ? 502 : 2;
      for (let sequence = 1; sequence <= rows; sequence += 1) {
        yield* io.append(
          "outbound",
          new AttemptChannel.OutboundEnvelope({
            version: AttemptChannel.PROTOCOL_VERSION,
            attemptId: execution.attempt.id,
            sequence: AttemptChannel.Sequence.make(sequence),
            sentAt: now,
            payload:
              sequence === 1
                ? new AttemptChannel.Started({ parentModel: ModelId.make("selected-parent") })
                : new AttemptChannel.SessionEvent({
                    event: new TextOutput({ session: parent, text: `row ${sequence}` }),
                  }),
          }),
        );
      }
      if (execution.attempt.number === 1)
        return yield* new AgentFailure({ message: "Retry explicitly" });
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
    const submission = new Submission({
      event: new Event({
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
      reader.transcript(new TranscriptAllQuery({ attemptId: id })),
    )).flat();
    const waiting = yield* engine.submit(
      new Submission({
        ...submission,
        event: new Event({
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
        Layer.provide(Layer.succeed(TriggerCondition)({ holds: () => Effect.succeed(true) })),
      ),
    ),
  );

const runCli = (directory: string, args: ReadonlyArray<string>) =>
  spawnSync(process.execPath, [cli, ...args], {
    cwd: directory,
    encoding: "utf8",
    timeout: 15_000,
  });

const test = it.extend<{
  directory: string;
  saved: Effect.Success<ReturnType<typeof seed>>;
}>({
  directory: async ({ task }, use) => {
    const directory = await mkdtemp(join(tmpdir(), `usine-export-${task.id}-`));
    try {
      await use(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  saved: async ({ directory }, use) => {
    await use(await Effect.runPromise(seed(directory).pipe(Effect.provide(NodeServices.layer))));
  },
});

describe("Run evidence export", { timeout: 30_000 }, () => {
  test("exports complete evidence for every Attempt beyond the UI page", async ({
    directory,
    saved,
  }) => {
    const runId = saved.snapshot.run.id;
    const exported = runCli(directory, ["export-run", runId]);
    assert.strictEqual(exported.status, 0, exported.stderr);
    const output = join(directory, `run-${encodeURIComponent(runId)}.json`);
    const evidence = Schema.decodeUnknownSync(RunEvidenceFromJson)(await readFile(output, "utf8"));

    assert.strictEqual(evidence.version, 1);
    assert.deepStrictEqual(evidence.snapshot, saved.snapshot);
    assert.deepStrictEqual(evidence.transcript, saved.transcript);
    assert.strictEqual(evidence.snapshot.attempts.length, 2);
    assert.strictEqual(evidence.transcript.length, 504);
    assert.strictEqual((await stat(output)).mode & 0o777, 0o600);
    assert.include(exported.stdout, output);
  });

  test("backs up live WAL state and exports the restored Run with all Attempts and transcripts", async ({
    directory,
    saved,
  }) => {
    const restored = join(directory, "restored");
    await mkdir(join(restored, ".usine"), { recursive: true });
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
      assert.strictEqual((await stat(output)).mode & 0o777, 0o600);
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
    const evidence = Schema.decodeUnknownSync(RunEvidenceFromJson)(
      await readFile(
        join(restored, `run-${encodeURIComponent(saved.snapshot.run.id)}.json`),
        "utf8",
      ),
    );
    assert.deepStrictEqual(evidence.snapshot, saved.snapshot);
    assert.deepStrictEqual(evidence.transcript, saved.transcript);
    assert.strictEqual(evidence.transcript.length, 504);
  });

  test("exports a Run awaiting approval to the requested destination", async ({
    directory,
    saved,
  }) => {
    const output = join(directory, "waiting.json");
    const exported = runCli(directory, [
      "export-run",
      saved.waitingSnapshot.run.id,
      "--output",
      "waiting.json",
    ]);
    assert.strictEqual(exported.status, 0, exported.stderr);
    const evidence = Schema.decodeUnknownSync(RunEvidenceFromJson)(await readFile(output, "utf8"));

    assert.deepStrictEqual(evidence.snapshot, saved.waitingSnapshot);
    assert.deepStrictEqual(evidence.snapshot.attempts, []);
    assert.deepStrictEqual(evidence.transcript, []);
    assert.include(exported.stdout, output);
  });

  test("refuses to overwrite an existing evidence file", async ({ directory, saved }) => {
    const output = join(directory, "evidence.json");
    await writeFile(output, "Previously exported evidence");
    const exported = runCli(directory, ["export-run", saved.snapshot.run.id, "--output", output]);

    assert.strictEqual(exported.status, 1);
    assert.match(exported.stderr, /write evidence/i);
    assert.include(exported.stderr, output);
    assert.strictEqual(await readFile(output, "utf8"), "Previously exported evidence");
  });

  test("reports a missing Run without publishing a file", async ({ directory, saved }) => {
    const missingId = `${saved.snapshot.run.id}/missing`;
    const output = join(directory, "missing.json");
    const exported = runCli(directory, ["export-run", missingId, "--output", output]);

    assert.strictEqual(exported.status, 1);
    assert.include(exported.stderr, missingId);
    assert.match(exported.stderr, /not found/i);
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("reports an unavailable output directory without creating it", async ({
    directory,
    saved,
  }) => {
    const parent = join(directory, "absent");
    const exported = runCli(directory, [
      "export-run",
      saved.snapshot.run.id,
      "--output",
      join(parent, "evidence.json"),
    ]);

    assert.strictEqual(exported.status, 1);
    assert.match(exported.stderr, /write evidence/i);
    await expect(stat(parent)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("refuses a missing runtime store without creating one", async ({ directory }) => {
    const exported = runCli(directory, ["export-run", "missing"]);

    assert.strictEqual(exported.status, 1);
    assert.match(exported.stderr, /read evidence/i);
    await expect(stat(join(directory, ".usine"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(directory, "run-missing.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("leaves an unrelated database unchanged when export fails", async ({ directory }) => {
    await mkdir(join(directory, ".usine"));
    const filename = join(directory, ".usine", "runtime.sqlite");
    const database = new DatabaseSync(filename);
    try {
      database.exec("CREATE TABLE original_marker (value TEXT)");
      database.exec("INSERT INTO original_marker VALUES ('preserve me')");
    } finally {
      database.close();
    }
    const original = await readFile(filename);
    const exported = runCli(directory, ["export-run", "missing"]);

    assert.strictEqual(exported.status, 1);
    assert.match(exported.stderr, /read evidence/i);
    assert.deepStrictEqual(await readFile(filename), original);
    await expect(stat(join(directory, "run-missing.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test.for(["corrupt", "directory"])(
    "reports a %s runtime store as a read failure",
    async (kind, { directory }) => {
      await mkdir(join(directory, ".usine"));
      const filename = join(directory, ".usine", "runtime.sqlite");
      if (kind === "directory") await mkdir(filename);
      else await writeFile(filename, "not a SQLite database");
      const exported = runCli(directory, ["export-run", "missing"]);

      assert.strictEqual(exported.status, 1);
      assert.match(exported.stderr, /read evidence/i);
      await expect(stat(join(directory, "run-missing.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});
