import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prune, replayedChecks, summaryTasks } from "./turbo-cache.mjs";

const task = (taskId, hash, status) => ({
  taskId,
  task: taskId.split("#")[1],
  hash,
  cache: { status },
});

test("only replayed tasks other than builds are reported", () => {
  const tasks = [
    task("@usine/core#build", "1111111111111111", "HIT"),
    task("@usine/core#test", "2222222222222222", "MISS"),
    task("@usine/core#check", "3333333333333333", "HIT"),
    task("@usine/engine#test", "4444444444444444", "HIT"),
  ];
  assert.deepEqual(
    replayedChecks(tasks).map(({ taskId }) => taskId),
    ["@usine/core#check", "@usine/engine#test"],
  );
});

test("pruning keeps the artifacts of this run's builds and deletes everything else", () => {
  const scratch = mkdtempSync(join(tmpdir(), "turbo-cache-"));
  try {
    const cache = join(scratch, "cache");
    mkdirSync(cache);
    const build = "aaaaaaaaaaaaaaaa";
    const test = "bbbbbbbbbbbbbbbb";
    const stale = "cccccccccccccccc";
    for (const hash of [build, test, stale]) {
      for (const suffix of [".tar.zst", "-meta.json", "-manifest.json"]) {
        writeFileSync(join(cache, `${hash}${suffix}`), "x");
      }
    }
    writeFileSync(join(cache, "unknown"), "x");
    const bytes = prune(cache, [
      task("@usine/core#build", build, "HIT"),
      task("@usine/core#test", test, "MISS"),
    ]);
    assert.deepEqual(readdirSync(cache).sort(), [
      `${build}-manifest.json`,
      `${build}-meta.json`,
      `${build}.tar.zst`,
    ]);
    assert.deepEqual(bytes, { deleted: 7, kept: 3 });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a job without a run summary fails instead of passing unchecked", () => {
  const scratch = mkdtempSync(join(tmpdir(), "turbo-runs-"));
  try {
    assert.throws(() => summaryTasks(join(scratch, "runs")), /No turbo run summary/u);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a task scheduled by several runs of one job reports its first run", () => {
  const scratch = mkdtempSync(join(tmpdir(), "turbo-runs-"));
  try {
    const runs = join(scratch, "runs");
    mkdirSync(runs);
    const summary = (startTime, tasks) => JSON.stringify({ execution: { startTime }, tasks });
    writeFileSync(
      join(runs, "b.json"),
      summary(2, [
        task("@usine/core#build", "1111111111111111", "HIT"),
        task("@usine/core#check", "2222222222222222", "MISS"),
      ]),
    );
    writeFileSync(
      join(runs, "a.json"),
      summary(1, [task("@usine/core#build", "1111111111111111", "MISS")]),
    );
    assert.deepEqual(
      summaryTasks(runs).map(({ taskId, cache }) => [taskId, cache.status]),
      [
        ["@usine/core#build", "MISS"],
        ["@usine/core#check", "MISS"],
      ],
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
