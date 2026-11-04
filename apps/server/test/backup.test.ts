import { NodeFileSystem } from "@effect/platform-node";
import { Effect, FileSystem } from "effect";
import { sqliteTempDirectory } from "../../../tooling/test/sqlite.mts";
// The Node process boundary uses native process handles and synchronous subprocess operations.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawnSync } from "node:child_process";
// Synchronous Node path callbacks retain the host platform’s path semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join, dirname, basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { assert, expect, it } from "@effect/vitest";

const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const directoryFixture = Effect.gen(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
      fileSystem.makeTempDirectory({
        directory: dirname(join(sqliteTempDirectory(), "usine-backup-")),
        prefix: basename(join(sqliteTempDirectory(), "usine-backup-")),
      }),
    ).pipe(
      Effect.flatMap((directory) =>
        Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.realPath(directory)),
      ),
    ),
    (directory) =>
      Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.remove(directory, { recursive: true, force: true }),
      ).pipe(Effect.orDie),
  );
  return directory;
});

const runBackup = (directory: string, output: string) =>
  spawnSync(process.execPath, [cli, "backup", output], {
    cwd: directory,
    encoding: "utf8",
    timeout: 15_000,
  });

// A cold CLI start in a parallel `pnpm test` exceeds vitest's 5 s default. The test timeout is
// above the spawn timeout so a slow CLI fails with the spawn's diagnostics.
const slowCli = { timeout: 30_000 };

/** Opens `filename` in WAL mode and writes `value` without checkpointing it. */
const openWithUncheckpointedRow = (filename: string, value: number) => {
  const database = new DatabaseSync(filename);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
  database.exec(`CREATE TABLE evidence (value); INSERT INTO evidence VALUES (${value})`);
  return database;
};

const evidence = (filename: string) => {
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    return database.prepare("SELECT value FROM evidence").all();
  } finally {
    database.close();
  }
};

it.live.each([
  { kind: "missing", reason: /NotFound/ },
  { kind: "corrupt", reason: /not a database/ },
  { kind: "directory", reason: /regular SQLite file/ },
])(
  "reports an unusable $kind source without creating a backup",
  ({ kind, reason }) =>
    Effect.gen(function* () {
      const directory = yield* directoryFixture;
      const runtime = join(directory, ".usine");
      const filename = join(runtime, "runtime.sqlite");
      if (kind !== "missing") {
        yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.makeDirectory(runtime),
        );
        // The durable storage is copied first; the failed runtime copy must remove it again.
        openWithUncheckpointedRow(join(runtime, "durable.sqlite"), 176).close();
      }
      if (kind === "directory")
        yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.makeDirectory(filename),
        );
      if (kind === "corrupt")
        yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.writeFileString(filename, "not SQLite"),
        );
      const originalEntries = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.readDirectory(directory),
      );
      const output = join(directory, "backup.sqlite");

      const result = runBackup(directory, output);

      assert.strictEqual(result.status, 1, result.stderr);
      assert.include(result.stderr, filename);
      assert.match(result.stderr, reason);
      if (kind === "corrupt") assert.include(result.stderr, output);
      const actual1 = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.readDirectory(directory),
      );
      assert.deepStrictEqual(actual1, originalEntries);
      if (kind === "missing") {
        const missingFile1 = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.stat(runtime),
        ).pipe(Effect.flip);
        expect(missingFile1.reason.cause).toMatchObject({
          code: "ENOENT",
        });
      }
      if (kind === "corrupt") {
        const actual2 = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.readFileString(filename),
        );
        assert.strictEqual(actual2, "not SQLite");
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  slowCli,
);

it.live.each([
  { outputName: "backup.sqlite", durableName: "backup.durable.sqlite" },
  { outputName: "backup.db", durableName: "backup.durable.db" },
  {
    outputName: "before-pi-1.4-2026-10-29",
    durableName: "before-pi-1.4-2026-10-29.durable.sqlite",
  },
  { outputName: "nightly", durableName: "nightly.durable.sqlite" },
])(
  "copies open stores to $outputName and $durableName",
  ({ outputName, durableName }) =>
    Effect.gen(function* () {
      const directory = yield* directoryFixture;
      const runtime = join(directory, ".usine");
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.makeDirectory(runtime),
      );
      const open = [
        openWithUncheckpointedRow(join(runtime, "runtime.sqlite"), 183),
        openWithUncheckpointedRow(join(runtime, "durable.sqlite"), 176),
      ];
      try {
        const output = join(directory, outputName);

        const result = runBackup(directory, output);

        assert.strictEqual(result.status, 0, result.stderr);
        const durable = join(directory, durableName);
        assert.include(result.stdout, output);
        assert.include(result.stdout, durable);
        assert.deepStrictEqual(evidence(output), [{ value: 183 }]);
        assert.deepStrictEqual(evidence(durable), [{ value: 176 }]);
        assert.strictEqual(
          (yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.stat(durable)))
            .mode & 0o777,
          0o600,
        );
      } finally {
        for (const database of open) database.close();
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  slowCli,
);

it.live.each([
  { kind: "existing", output: "backup.sqlite", reason: "AlreadyExists" },
  { kind: "source", output: ".usine/runtime.sqlite", reason: "AlreadyExists" },
  { kind: "symlink", output: "backup.sqlite", reason: "AlreadyExists" },
  { kind: "missing parent", output: "absent/backup.sqlite", reason: "NotFound" },
  { kind: "long filename", output: `${"b".repeat(256)}.sqlite`, reason: "ENAMETOOLONG" },
])(
  "reports a $kind destination and preserves existing files",
  ({ kind, output, reason }) =>
    Effect.gen(function* () {
      const directory = yield* directoryFixture;
      const runtime = join(directory, ".usine");
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.makeDirectory(runtime),
      );
      const filename = join(runtime, "runtime.sqlite");
      const database = new DatabaseSync(filename);
      try {
        database.exec("CREATE TABLE evidence (value); INSERT INTO evidence VALUES (74)");
      } finally {
        database.close();
      }
      const original = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.readFile(filename).pipe(Effect.map(Buffer.from)),
      );
      const destination = join(directory, output);
      if (kind === "existing")
        yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.writeFileString(destination, "previous backup"),
        );
      if (kind === "symlink")
        yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.symlink(filename, destination),
        );
      const originalEntries = (yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.readDirectory(directory),
      )).sort();
      const originalRuntimeEntries = (yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.readDirectory(runtime),
      )).sort();

      const result = runBackup(directory, destination);

      assert.strictEqual(result.status, 1, result.stderr);
      assert.include(result.stderr, destination);
      assert.include(result.stderr, reason);
      const actual3 = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.readFile(filename).pipe(Effect.map(Buffer.from)),
      );
      assert.deepStrictEqual(actual3, original);
      if (kind === "existing") {
        const actual4 = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.readFileString(destination),
        );
        assert.strictEqual(actual4, "previous backup");
      }
      if (kind === "symlink") {
        const actual5 = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.realPath(destination),
        );
        assert.strictEqual(actual5, filename);
      }
      assert.deepStrictEqual(
        (yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.readDirectory(directory),
        )).sort(),
        originalEntries,
      );
      assert.deepStrictEqual(
        (yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.readDirectory(runtime),
        )).sort(),
        originalRuntimeEntries,
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  slowCli,
);
