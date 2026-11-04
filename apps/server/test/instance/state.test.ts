import { jsonKey } from "@usine/core/json-key";
// The Node process boundary uses native process handles and synchronous subprocess operations.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawnSync } from "node:child_process";
// This Node boundary needs synchronous filesystem operations that FileSystem does not expose.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// Synchronous Node path callbacks retain the host platform’s path semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { InstanceDirectory } from "@usine/core/instance";
import { DateTime, Effect, Option, Schema } from "effect";
import { afterEach, assert, describe, it } from "@effect/vitest";
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
  signalProcess,
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
  InstanceRecord.make({
    pid: ProcessId.make(pid),
    version: "1.2.3",
    startedAt: DateTime.makeUnsafe("2026-10-25T16:00:00.000Z"),
    launch: InstanceLaunch.make({
      node: process.execPath,
      nodeOptions: [],
      script: "/opt/usine/dist/main.js",
      port: Port.make(8112),
      logLevel: "Info",
      allowVolatileInstance: false,
    }),
  });

/** `.usine/instance.json` as `@usine/server` 0.3.0 at e22d67c wrote it, before `launch.logLevel`. */
const previousVersionRecord = (pid: number) =>
  `${jsonKey({
    pid,
    version: "0.3.0",
    startedAt: "2026-10-25T18:00:00.000Z",
    launch: {
      node: process.execPath,
      nodeOptions: [],
      script: "/opt/usine/apps/server/dist/main.js",
      port: 8_113,
      allowVolatileInstance: false,
    },
  })}\n`;

/** Returns the PID of a process that has exited. */
const exitedPid = (): number => {
  const result = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf8",
  });
  return Number(result.stdout);
};

const probe = (directory: InstanceDirectory) =>
  Effect.runPromise(probeInstance(directory).pipe(Effect.provide(NodeServices.layer)));

const pid1OwnedByThisUser = () => {
  if (process.platform !== "linux") return false;
  try {
    const uid = /^Uid:\s+(\d+)/mu.exec(readFileSync("/proc/1/status", "utf8"))?.[1];
    return uid !== undefined && Number(uid) === process.getuid?.();
  } catch {
    return false;
  }
};

describe("instance state", () => {
  it.live("reports a folder that never ran usine as stopped", () =>
    Effect.gen(function* () {
      const state = yield* Effect.promise(() => probe(instanceFolder()));
      assert.deepStrictEqual(state, Stopped.make({ stale: Option.none() }));
    }),
  );

  it.live("reports a record without a lock holder as stale, even if its pid is live", () =>
    Effect.gen(function* () {
      const directory = instanceFolder();
      const files = instanceFiles(directory);
      mkdirSync(files.folder);
      writeFileSync(files.lock, "");
      // The test process is live, but it doesn't hold the lock: a reused pid never counts.
      const actual1 = yield* Schema.encodeEffect(InstanceRecord)(recordFor(process.pid));
      const json1 = jsonKey(actual1);
      writeFileSync(files.record, json1);
      const state = yield* Effect.promise(() => probe(directory));
      assert(state._tag === "Stopped");
      assert.deepStrictEqual(state.stale, Option.some(process.pid));
    }),
  );

  it.live("reports the lock holder whose record names a live process as running", () =>
    Effect.gen(function* () {
      const directory = instanceFolder();
      yield* Effect.gen(function* () {
        yield* holdInstance(directory, recordFor(process.pid));
        const state = yield* probeInstance(directory);
        assert.instanceOf(state, Running);
        assert.strictEqual(state.record.pid, process.pid);
        assert.strictEqual(state.record.launch.port, 8_112);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
    }),
  );

  it.live("reads the record that the previous engine version wrote", () =>
    Effect.gen(function* () {
      const directory = instanceFolder();
      const files = instanceFiles(directory);
      yield* Effect.gen(function* () {
        yield* holdInstance(directory, recordFor(process.pid));
        writeFileSync(files.record, previousVersionRecord(process.pid));
        const state = yield* probeInstance(directory);
        assert.instanceOf(state, Running);
        assert.strictEqual(state.record.version, "0.3.0");
        assert.strictEqual(state.record.launch.port, 8_113);
        assert.strictEqual(state.record.launch.logLevel, "Info");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
    }),
  );

  it.live("reports a lock holder without a usable record as unrecorded", () =>
    Effect.gen(function* () {
      const directory = instanceFolder();
      const files = instanceFiles(directory);
      yield* Effect.gen(function* () {
        yield* holdInstance(directory, recordFor(process.pid));
        // An older usine writes only the pid file.
        rmSync(files.record);
        const legacy = yield* probeInstance(directory);
        assert(legacy._tag === "Unrecorded");
        assert.deepStrictEqual(legacy.pid, Option.some(process.pid));
        const valueDecoded1 = yield* Schema.encodeEffect(InstanceRecord)(recordFor(exitedPid()));
        // A record of an exited process, left by a crash before this holder wrote its own.
        const json2 = jsonKey(valueDecoded1);
        writeFileSync(files.record, json2);
        writeFileSync(files.pid, `${exitedPid()}\n`);
        const starting = yield* probeInstance(directory);
        assert.deepStrictEqual(starting, Unrecorded.make({ pid: Option.none() }));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
    }),
  );

  // Signaling pid 1 as another user fails with EPERM. As root, or in a container whose init runs
  // as this user (the attempt image's tini runs as `usine`), the signal would reach init and stop
  // it, so the case runs only where pid 1 belongs to someone else.
  it.live.skipIf(process.getuid?.() === 0 || pid1OwnedByThisUser())(
    "reports a process that it may not signal",
    () =>
      Effect.gen(function* () {
        const error = yield* signalProcess(ProcessId.make(1), "SIGTERM").pipe(Effect.flip);
        assert.instanceOf(error, SignalError);
        assert.strictEqual(error.signal, "SIGTERM");
      }),
  );

  it.live("succeeds when the process exited before the signal", () =>
    signalProcess(ProcessId.make(exitedPid()), "SIGTERM"),
  );
});
