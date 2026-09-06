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

const instanceGuidance =
  "Run usine backup from the instance folder that holds .usine/runtime.sqlite.";

test.for([
  { kind: "missing", reason: "NotFound", guidance: instanceGuidance },
  {
    kind: "corrupt",
    reason: "file is not a database",
    guidance:
      "Check the instance database and the space and permissions of the output directory before retrying.",
  },
  {
    kind: "directory",
    reason: "Expected a regular SQLite file, found Directory",
    guidance: instanceGuidance,
  },
])(
  "refuses a $kind source by naming the store, the reason, and the next step, without publishing a backup or initializing the store",
  async ({ kind, reason, guidance }, { directory }) => {
    const runtime = join(directory, ".usine");
    const filename = join(runtime, "runtime.sqlite");
    if (kind !== "missing") await mkdir(runtime);
    if (kind === "directory") await mkdir(filename);
    if (kind === "corrupt") await writeFile(filename, "not SQLite");
    const output = join(directory, "backup.sqlite");
    const result = runBackup(directory, output);
    assert.strictEqual(result.status, 1, result.stderr);
    // The CLI names the store under its resolved working directory. SQLite reads the
    // source and writes the staged copy in one call, so a copy failure names both
    // sides; failures before the copy never mention the destination.
    const store = join(await realpath(directory), ".usine", "runtime.sqlite");
    const subject =
      kind === "corrupt"
        ? `copy the runtime store at ${store} into ${output}`
        : `open the runtime store at ${store}`;
    assert.include(result.stderr, `Could not ${subject} (${reason}). ${guidance}`);
    if (kind !== "corrupt") assert.notInclude(result.stderr, output);
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    assert.isFalse((await readdir(directory)).some((name) => name.startsWith(".usine-backup-")));
    if (kind === "missing") await expect(stat(runtime)).rejects.toMatchObject({ code: "ENOENT" });
    if (kind === "corrupt") assert.strictEqual(await readFile(filename, "utf8"), "not SQLite");
  },
);

const existingGuidance = "Choose a new output path; backups never replace existing files.";

test.for([
  {
    kind: "existing",
    failure: "publish the backup at",
    reason: "AlreadyExists",
    guidance: existingGuidance,
  },
  {
    kind: "source",
    failure: "publish the backup at",
    reason: "AlreadyExists",
    guidance: existingGuidance,
  },
  {
    kind: "symlink",
    failure: "publish the backup at",
    reason: "AlreadyExists",
    guidance: existingGuidance,
  },
  {
    kind: "missing-parent",
    failure: "stage the backup beside",
    reason: "NotFound",
    guidance: "Choose an output path inside an existing writable directory.",
  },
  {
    // A name past NAME_MAX fails the hard link with an errno the platform does not
    // normalize, the same way a FAT, exFAT, or network volume without hard links
    // fails with EPERM or ENOTSUP; the CLI must then show the code, not "Unknown",
    // and must not tell the operator the file already exists.
    kind: "unlinkable",
    failure: "publish the backup at",
    reason: "ENAMETOOLONG",
    guidance:
      "The completed copy is hard-linked into place; use an output directory on a filesystem that supports hard links, or resolve the reported reason, and retry.",
  },
])(
  "preserves files, cleans staging, and names the $kind destination that blocked publication with its next step",
  async ({ kind, failure, reason, guidance }, { directory }) => {
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
          : kind === "unlinkable"
            ? join(directory, `${"b".repeat(256)}.sqlite`)
            : join(directory, "backup.sqlite");
    if (kind === "existing") await writeFile(output, "previous backup");
    if (kind === "symlink") await symlink(filename, output);
    const result = runBackup(directory, output);
    assert.strictEqual(result.status, 1, result.stderr);
    assert.include(result.stderr, `Could not ${failure} ${output} (${reason}). ${guidance}`);
    assert.deepStrictEqual(await readFile(filename), original);
    if (kind === "existing") assert.strictEqual(await readFile(output, "utf8"), "previous backup");
    if (kind === "missing-parent")
      await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    if (kind === "unlinkable") assert.deepStrictEqual(await readdir(directory), [".usine"]);
    for (const scanned of [directory, join(directory, ".usine")]) {
      assert.isFalse((await readdir(scanned)).some((name) => name.startsWith(".usine-backup-")));
    }
  },
);
