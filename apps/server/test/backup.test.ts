import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { assert, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const test = it.extend<{ directory: string }>({
  directory: async ({ task }, use) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), `usine-backup-${task.id}-`)));
    try {
      await use(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
});

const runBackup = (directory: string, output: string) =>
  spawnSync(process.execPath, [cli, "backup", output], {
    cwd: directory,
    encoding: "utf8",
    timeout: 15_000,
  });

test.for([
  { kind: "missing", reason: /NotFound/ },
  { kind: "corrupt", reason: /not a database/ },
  { kind: "directory", reason: /regular SQLite file/ },
])(
  "reports an unusable $kind source without creating a backup",
  async ({ kind, reason }, { directory }) => {
    const runtime = join(directory, ".usine");
    const filename = join(runtime, "runtime.sqlite");
    if (kind !== "missing") await mkdir(runtime);
    if (kind === "directory") await mkdir(filename);
    if (kind === "corrupt") await writeFile(filename, "not SQLite");
    const originalEntries = await readdir(directory);
    const output = join(directory, "backup.sqlite");

    const result = runBackup(directory, output);

    assert.strictEqual(result.status, 1, result.stderr);
    assert.include(result.stderr, filename);
    assert.match(result.stderr, reason);
    if (kind === "corrupt") assert.include(result.stderr, output);
    assert.deepStrictEqual(await readdir(directory), originalEntries);
    if (kind === "missing") await expect(stat(runtime)).rejects.toMatchObject({ code: "ENOENT" });
    if (kind === "corrupt") assert.strictEqual(await readFile(filename, "utf8"), "not SQLite");
  },
);

test.for([
  { kind: "existing", output: "backup.sqlite", reason: "AlreadyExists" },
  { kind: "source", output: ".usine/runtime.sqlite", reason: "AlreadyExists" },
  { kind: "symlink", output: "backup.sqlite", reason: "AlreadyExists" },
  { kind: "missing parent", output: "absent/backup.sqlite", reason: "NotFound" },
  { kind: "long filename", output: `${"b".repeat(256)}.sqlite`, reason: "ENAMETOOLONG" },
])(
  "reports a $kind destination and preserves existing files",
  async ({ kind, output, reason }, { directory }) => {
    const runtime = join(directory, ".usine");
    await mkdir(runtime);
    const filename = join(runtime, "runtime.sqlite");
    const database = new DatabaseSync(filename);
    try {
      database.exec("CREATE TABLE evidence (value); INSERT INTO evidence VALUES (74)");
    } finally {
      database.close();
    }
    const original = await readFile(filename);
    const destination = join(directory, output);
    if (kind === "existing") await writeFile(destination, "previous backup");
    if (kind === "symlink") await symlink(filename, destination);
    const originalEntries = (await readdir(directory)).sort();
    const originalRuntimeEntries = (await readdir(runtime)).sort();

    const result = runBackup(directory, destination);

    assert.strictEqual(result.status, 1, result.stderr);
    assert.include(result.stderr, destination);
    assert.include(result.stderr, reason);
    assert.deepStrictEqual(await readFile(filename), original);
    if (kind === "existing")
      assert.strictEqual(await readFile(destination, "utf8"), "previous backup");
    if (kind === "symlink") assert.strictEqual(await realpath(destination), filename);
    assert.deepStrictEqual((await readdir(directory)).sort(), originalEntries);
    assert.deepStrictEqual((await readdir(runtime)).sort(), originalRuntimeEntries);
  },
);
