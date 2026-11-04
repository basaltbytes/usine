import { jsonKey } from "@usine/core/json-key";
// This Node boundary needs synchronous filesystem operations that FileSystem does not expose.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// Synchronous Node path callbacks retain the host platform’s path semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { InstanceDirectory } from "@usine/core/instance";
import { DateTime, Effect, Exit, Option, Schema, Scope } from "effect";
import { afterEach, assert, describe, it } from "@effect/vitest";
import { Port } from "../../src/cli.ts";
import {
  InstanceInUseError,
  InstanceLockError,
  holdInstance,
  lockHeld,
} from "../../src/instance/lock.ts";
import {
  InstanceLaunch,
  InstanceRecord,
  InstanceRecordError,
  ProcessId,
  instanceFiles,
  markStoppingSync,
  readRecord,
} from "../../src/instance/record.ts";

const folders: Array<string> = [];

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const instanceFolder = () => {
  const folder = mkdtempSync(join(tmpdir(), "usine-lock-"));
  folders.push(folder);
  return InstanceDirectory.make(folder);
};

const record = InstanceRecord.make({
  pid: ProcessId.make(process.pid),
  version: "1.2.3",
  startedAt: DateTime.makeUnsafe("2026-10-25T16:00:00.000Z"),
  launch: InstanceLaunch.make({
    node: process.execPath,
    nodeOptions: ["--enable-source-maps"],
    script: "/opt/usine/dist/main.js",
    port: Port.make(8111),
    logLevel: "Info",
    allowVolatileInstance: false,
  }),
});

describe("instance lock", () => {
  it.live(
    "refuses a second holder, names the first one's pid, and frees the folder on release",
    () =>
      Effect.gen(function* () {
        const directory = instanceFolder();
        const files = instanceFiles(directory);
        yield* Effect.gen(function* () {
          const locked = yield* lockHeld(files);
          assert.isFalse(locked);
          assert.isFalse(existsSync(files.lock), "probing creates no lock file");
          const first = yield* Scope.make();
          yield* holdInstance(directory, record).pipe(Scope.provide(first));
          const currentLocked = yield* lockHeld(files);
          assert.isTrue(currentLocked);
          assert.strictEqual(readFileSync(files.pid, "utf8").trim(), String(process.pid));
          const instanceRecord = yield* readRecord(files);
          assert.deepStrictEqual(instanceRecord, Option.some(record));
          const refused = yield* holdInstance(directory, record).pipe(Effect.scoped, Effect.flip);
          const matchesRefused = Schema.is(InstanceInUseError)(refused);
          assert(matchesRefused);
          assert.deepStrictEqual(refused.holder, Option.some(process.pid));
          yield* Scope.close(first, Exit.void);
          const nextLocked = yield* lockHeld(files);
          assert.isFalse(nextLocked);
          assert.isFalse(existsSync(files.pid), "release removes the pid file");
          assert.isFalse(existsSync(files.record), "release removes the record");
          yield* holdInstance(directory, record).pipe(Effect.scoped);
        }).pipe(Effect.provide(NodeServices.layer));
      }),
  );

  it.live("reports a folder it cannot lock apart from one another process holds", () =>
    Effect.gen(function* () {
      const directory = instanceFolder();
      writeFileSync(join(directory, ".usine"), "not a folder");
      const refused = yield* holdInstance(directory, record).pipe(
        Effect.scoped,
        Effect.flip,
        Effect.provide(NodeServices.layer),
      );
      const matchesRefused = Schema.is(InstanceLockError)(refused);
      assert(matchesRefused);
    }),
  );

  it.live("records the start of a drain without changing the rest of the record", () =>
    Effect.gen(function* () {
      const directory = instanceFolder();
      const files = instanceFiles(directory);
      yield* Effect.gen(function* () {
        yield* holdInstance(directory, record);
        markStoppingSync(files, record);
        const read = yield* readRecord(files);
        assert(Option.isSome(read));
        const stopping = read.value;
        assert.isDefined(stopping.stoppingSince);
        const valueDecoded1 = yield* Schema.encodeEffect(InstanceLaunch)(stopping.launch);
        assert.deepStrictEqual(valueDecoded1, {
          node: process.execPath,
          nodeOptions: ["--enable-source-maps"],
          script: "/opt/usine/dist/main.js",
          port: 8_111,
          logLevel: "Info",
          allowVolatileInstance: false,
        });
        assert.strictEqual(stopping.pid, record.pid);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
    }),
  );

  it.live("rejects an instance record that does not decode", () =>
    Effect.gen(function* () {
      const directory = instanceFolder();
      const files = instanceFiles(directory);
      yield* Effect.gen(function* () {
        yield* holdInstance(directory, record);
        const json1 = jsonKey({
          pid: "not a pid",
        });
        writeFileSync(files.record, json1);
        const error = yield* readRecord(files).pipe(Effect.flip);
        assert.instanceOf(error, InstanceRecordError);
        assert.strictEqual(error.path, files.record);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
    }),
  );
});
