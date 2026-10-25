import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { InstanceDirectory } from "@usine/core/instance";
import { DateTime, Effect, Option, Schema } from "effect";
import { afterEach, assert, describe, it } from "vitest";
import { Port } from "../../src/cli.ts";
import { holdInstance } from "../../src/instance/lock.ts";
import {
  InstanceLaunch,
  InstanceRecord,
  ProcessId,
  instanceFiles,
} from "../../src/instance/record.ts";
import {
  Running,
  SignalError,
  Stopped,
  Unrecorded,
  probeInstance,
  terminate,
} from "../../src/instance/state.ts";

const folders: Array<string> = [];

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const instanceFolder = () => {
  const folder = mkdtempSync(join(tmpdir(), "usine-state-"));
  folders.push(folder);
  return InstanceDirectory.make(folder);
};

const recordFor = (pid: number) =>
  new InstanceRecord({
    pid: ProcessId.make(pid),
    version: "1.2.3",
    startedAt: DateTime.makeUnsafe("2026-10-25T16:00:00.000Z"),
    launch: new InstanceLaunch({
      node: process.execPath,
      nodeOptions: [],
      script: "/opt/usine/dist/main.js",
      port: Port.make(8_112),
      logLevel: "Info",
      allowVolatileInstance: false,
    }),
  });

/** Returns the PID of a process that has exited. */
const exitedPid = (): number => {
  const result = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf8",
  });
  return Number(result.stdout);
};

const probe = (directory: InstanceDirectory) =>
  Effect.runPromise(probeInstance(directory).pipe(Effect.provide(NodeServices.layer)));

describe("instance state", () => {
  it("reports a folder that never ran usine as stopped", async () => {
    const state = await probe(instanceFolder());
    assert.deepStrictEqual(state, new Stopped({ stale: Option.none() }));
  });

  it("reports a record without a lock holder as stale, even if its pid is live", async () => {
    const directory = instanceFolder();
    const files = instanceFiles(directory);
    mkdirSync(files.folder);
    writeFileSync(files.lock, "");
    // The test process is live, but it doesn't hold the lock: a reused pid never counts.
    writeFileSync(
      files.record,
      JSON.stringify(Schema.encodeSync(InstanceRecord)(recordFor(process.pid))),
    );
    const state = await probe(directory);
    assert(state._tag === "Stopped");
    assert.deepStrictEqual(state.stale, Option.some(process.pid));
  });

  it("reports the lock holder whose record names a live process as running", async () => {
    const directory = instanceFolder();
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* holdInstance(directory, recordFor(process.pid));
        const state = yield* probeInstance(directory);
        assert.instanceOf(state, Running);
        assert.strictEqual(state.record.pid, process.pid);
        assert.strictEqual(state.record.launch.port, 8_112);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  });

  it("reports a lock holder without a usable record as unrecorded", async () => {
    const directory = instanceFolder();
    const files = instanceFiles(directory);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* holdInstance(directory, recordFor(process.pid));
        // An older usine writes only the pid file.
        rmSync(files.record);
        const legacy = yield* probeInstance(directory);
        assert(legacy._tag === "Unrecorded");
        assert.deepStrictEqual(legacy.pid, Option.some(process.pid));
        // A record of an exited process, left by a crash before this holder wrote its own.
        writeFileSync(
          files.record,
          JSON.stringify(Schema.encodeSync(InstanceRecord)(recordFor(exitedPid()))),
        );
        writeFileSync(files.pid, `${exitedPid()}\n`);
        const starting = yield* probeInstance(directory);
        assert.deepStrictEqual(starting, new Unrecorded({ pid: Option.none() }));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  });

  // Signaling pid 1 as another user fails with EPERM; as root, it would reach init.
  it.skipIf(process.getuid?.() === 0)("reports a process that it may not signal", async () => {
    const error = await Effect.runPromise(terminate(ProcessId.make(1)).pipe(Effect.flip));
    assert.instanceOf(error, SignalError);
    assert.strictEqual(error.signal, "SIGTERM");
  });

  it("succeeds when the process exited before the signal", async () => {
    await Effect.runPromise(terminate(ProcessId.make(exitedPid())));
  });
});
