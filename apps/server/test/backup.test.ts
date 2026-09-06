import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { assert, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const test = it.extend<{ directory: string }>({
  directory: async ({ task }, use) => {
    const directory = await mkdtemp(join(tmpdir(), `usine-backup-${task.id}-`));
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

test.for(["missing", "corrupt", "directory"])(
  "refuses a %s source without publishing a backup or initializing the store",
  async (kind, { directory }) => {
    const runtime = join(directory, ".usine");
    const filename = join(runtime, "runtime.sqlite");
    if (kind !== "missing") await mkdir(runtime);
    if (kind === "directory") await mkdir(filename);
    if (kind === "corrupt") await writeFile(filename, "not SQLite");
    const output = join(directory, "backup.sqlite");
    const result = runBackup(directory, output);
    assert.strictEqual(result.status, 1, result.stderr);
    assert.match(result.stderr, /Could not back up runtime store/);
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    assert.isFalse((await readdir(directory)).some((name) => name.startsWith(".usine-backup-")));
    if (kind === "missing") await expect(stat(runtime)).rejects.toMatchObject({ code: "ENOENT" });
    if (kind === "corrupt") assert.strictEqual(await readFile(filename, "utf8"), "not SQLite");
  },
);

test.for(["existing", "source", "symlink", "missing-parent"])(
  "preserves files and cleans staging when the destination is %s",
  async (kind, { directory }) => {
    await mkdir(join(directory, ".usine"));
    const filename = join(directory, ".usine", "runtime.sqlite");
    const database = new DatabaseSync(filename);
    database.exec("CREATE TABLE evidence (value); INSERT INTO evidence VALUES (74)");
    database.close();
    const original = await readFile(filename);
    const output =
      kind === "source"
        ? filename
        : kind === "missing-parent"
          ? join(directory, "absent", "backup.sqlite")
          : join(directory, "backup.sqlite");
    if (kind === "existing") await writeFile(output, "previous backup");
    if (kind === "symlink") await symlink(filename, output);
    const result = runBackup(directory, output);
    assert.strictEqual(result.status, 1, result.stderr);
    assert.match(result.stderr, /Could not back up runtime store/);
    assert.deepStrictEqual(await readFile(filename), original);
    if (kind === "existing") assert.strictEqual(await readFile(output, "utf8"), "previous backup");
    if (kind === "missing-parent")
      await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    for (const parent of [directory, join(directory, ".usine")]) {
      assert.isFalse((await readdir(parent)).some((name) => name.startsWith(".usine-backup-")));
    }
  },
);
