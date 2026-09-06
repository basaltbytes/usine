import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
import { TranscriptAllQuery } from "@usine/engine/transcript";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { assert, describe, it } from "vitest";
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
  }).pipe(Effect.provide(layer(InstanceDirectory.make(directory)).pipe(Layer.provide(executor))));

const runCli = (directory: string, args: ReadonlyArray<string>) =>
  spawnSync(process.execPath, [cli, ...args], {
    cwd: directory,
    encoding: "utf8",
    timeout: 15_000,
  });

describe("Run evidence export", () => {
  it("exports all Attempts and transcripts beyond the UI page, and reports failures without overwriting evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "usine-export-test-"));
    try {
      const saved = await Effect.runPromise(
        seed(directory).pipe(Effect.provide(NodeServices.layer)),
      );
      const runId = saved.snapshot.run.id;
      const exported = runCli(directory, ["export-run", runId]);
      assert.strictEqual(exported.status, 0, exported.stderr);
      const output = join(directory, `run-${encodeURIComponent(runId)}.json`);
      const original = await readFile(output, "utf8");
      const evidence = Schema.decodeUnknownSync(RunEvidenceFromJson)(original);
      assert.deepStrictEqual(evidence.snapshot, saved.snapshot);
      assert.deepStrictEqual(evidence.transcript, saved.transcript);
      assert.strictEqual(evidence.snapshot.attempts.length, 2);
      assert.strictEqual(evidence.transcript.length, 504);
      assert.strictEqual((await stat(output)).mode & 0o777, 0o600);
      assert.match(exported.stdout, /Exported Run/);

      const overwrite = runCli(directory, ["export-run", runId]);
      assert.strictEqual(overwrite.status, 1);
      assert.match(overwrite.stderr, /AlreadyExists/);
      assert.notMatch(overwrite.stdout, /Exported Run/);
      assert.strictEqual(await readFile(output, "utf8"), original);

      const waiting = runCli(directory, [
        "export-run",
        saved.waitingSnapshot.run.id,
        "--output",
        "waiting.json",
      ]);
      assert.strictEqual(waiting.status, 0, waiting.stderr);
      const waitingEvidence = Schema.decodeUnknownSync(RunEvidenceFromJson)(
        await readFile(join(directory, "waiting.json"), "utf8"),
      );
      assert.deepStrictEqual(waitingEvidence.snapshot, saved.waitingSnapshot);
      assert.deepStrictEqual(waitingEvidence.snapshot.attempts, []);
      assert.deepStrictEqual(waitingEvidence.transcript, []);

      const missing = runCli(directory, ["export-run", "missing/run", "--output", "missing.json"]);
      assert.strictEqual(missing.status, 1);
      assert.match(missing.stderr, /Run missing\/run was not found/);
      assert.notMatch(missing.stdout, /Exported Run/);
      const unwritable = runCli(directory, [
        "export-run",
        runId,
        "--output",
        "absent/evidence.json",
      ]);
      assert.strictEqual(unwritable.status, 1);
      assert.match(unwritable.stderr, /Could not write evidence/);
      assert.deepStrictEqual(
        (await readdir(directory)).sort(),
        [".usine", `run-${encodeURIComponent(runId)}.json`, "waiting.json"].sort(),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("refuses a missing runtime store without creating one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "usine-export-empty-"));
    try {
      const result = runCli(directory, ["export-run", "missing"]);
      assert.strictEqual(result.status, 1);
      assert.match(result.stderr, /Could not read evidence/);
      assert.deepStrictEqual(await readdir(directory), []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses an unrelated database without changing its contents or journal mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "usine-export-unrelated-"));
    try {
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
      const result = runCli(directory, ["export-run", "missing"]);
      assert.strictEqual(result.status, 1);
      assert.match(result.stderr, /Could not read evidence/);
      assert.notMatch(result.stdout, /Exported Run/);
      assert.deepStrictEqual(await readFile(filename), original);
      assert.deepStrictEqual(await readdir(directory), [".usine"]);
      assert.deepStrictEqual(await readdir(join(directory, ".usine")), ["runtime.sqlite"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["corrupt", "directory"])(
    "reports a %s runtime store as a read failure",
    async (kind) => {
      const directory = await mkdtemp(join(tmpdir(), "usine-export-invalid-"));
      try {
        await mkdir(join(directory, ".usine"));
        const filename = join(directory, ".usine", "runtime.sqlite");
        if (kind === "directory") await mkdir(filename);
        else await writeFile(filename, "not a SQLite database");
        const result = runCli(directory, ["export-run", "missing"]);
        assert.strictEqual(result.status, 1);
        assert.match(result.stderr, /Could not read evidence/);
        assert.notMatch(result.stdout, /Exported Run/);
        assert.deepStrictEqual(await readdir(directory), [".usine"]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
