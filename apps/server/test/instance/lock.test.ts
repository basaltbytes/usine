import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { InstanceDirectory } from "@usine/core/instance";
import { DateTime, Effect, Exit, Option, Schema, Scope } from "effect";
import { afterEach, assert, describe, it } from "vitest";
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

const record = new InstanceRecord({
  pid: ProcessId.make(process.pid),
  version: "1.2.3",
  startedAt: DateTime.makeUnsafe("2026-10-25T16:00:00.000Z"),
  launch: new InstanceLaunch({
    node: process.execPath,
    nodeOptions: ["--enable-source-maps"],
    script: "/opt/usine/dist/main.js",
    port: Port.make(8_111),
    allowVolatileInstance: false,
  }),
});

describe("instance lock", () => {
  it("refuses a second holder, names the first one's pid, and frees the folder on release", async () => {
    const directory = instanceFolder();
    const files = instanceFiles(directory);
    await Effect.runPromise(
      Effect.gen(function* () {
        assert.isFalse(yield* lockHeld(files));
        assert.isFalse(existsSync(files.lock), "probing creates no lock file");
        const first = yield* Scope.make();
        yield* holdInstance(directory, record).pipe(Scope.provide(first));
        assert.isTrue(yield* lockHeld(files));
        assert.strictEqual(readFileSync(files.pid, "utf8").trim(), String(process.pid));
        assert.deepStrictEqual(yield* readRecord(files), Option.some(record));
        const refused = yield* holdInstance(directory, record).pipe(Effect.scoped, Effect.flip);
        assert(refused instanceof InstanceInUseError);
        assert.deepStrictEqual(refused.holder, Option.some(process.pid));
        yield* Scope.close(first, Exit.void);
        assert.isFalse(yield* lockHeld(files));
        assert.isFalse(existsSync(files.pid), "release removes the pid file");
        assert.isFalse(existsSync(files.record), "release removes the record");
        yield* holdInstance(directory, record).pipe(Effect.scoped);
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  });

  it("reports a folder it cannot lock apart from one another process holds", async () => {
    const directory = instanceFolder();
    writeFileSync(join(directory, ".usine"), "not a folder");
    const refused = await Effect.runPromise(
      holdInstance(directory, record).pipe(
        Effect.scoped,
        Effect.flip,
        Effect.provide(NodeServices.layer),
      ),
    );
    assert(refused instanceof InstanceLockError);
  });

  it("records the start of a drain without changing the rest of the record", async () => {
    const directory = instanceFolder();
    const files = instanceFiles(directory);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* holdInstance(directory, record);
        markStoppingSync(files, record);
        const read = yield* readRecord(files);
        assert(Option.isSome(read));
        const stopping = read.value;
        assert.isDefined(stopping.stoppingSince);
        assert.deepStrictEqual(Schema.encodeSync(InstanceLaunch)(stopping.launch), {
          node: process.execPath,
          nodeOptions: ["--enable-source-maps"],
          script: "/opt/usine/dist/main.js",
          port: 8_111,
          allowVolatileInstance: false,
        });
        assert.strictEqual(stopping.pid, record.pid);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  });

  it("rejects an instance record that does not decode", async () => {
    const directory = instanceFolder();
    const files = instanceFiles(directory);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* holdInstance(directory, record);
        writeFileSync(files.record, JSON.stringify({ pid: "not a pid" }));
        const error = yield* readRecord(files).pipe(Effect.flip);
        assert.instanceOf(error, InstanceRecordError);
        assert.strictEqual(error.path, files.record);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  });
});
