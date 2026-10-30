import assert from "node:assert/strict";
import { access, mkdtemp, rm, statfs, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sqliteTempDirectory } from "./sqlite.mts";

test("SQLite fixtures use the OS temp directory when memory storage is unavailable", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "usine-temp-selection-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(sqliteTempDirectory(join(directory, "missing")), tmpdir());
  const file = join(directory, "file");
  await writeFile(file, "not a directory");
  assert.equal(sqliteTempDirectory(file), tmpdir());
  if ((await statfs(directory)).type !== 0x01021994) {
    assert.equal(sqliteTempDirectory(directory), tmpdir());
  }
});

test("SQLite fixtures select writable shared memory when available", async (t) => {
  try {
    assert.equal((await statfs("/dev/shm")).type, 0x01021994);
    await access("/dev/shm", constants.W_OK | constants.X_OK);
  } catch {
    t.skip("Writable tmpfs is unavailable on this host");
    return;
  }
  const directory = await mkdtemp(join(sqliteTempDirectory(), "usine-temp-selection-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal((await statfs(directory)).type, 0x01021994);
});
