// Keeps CI's turbo cache to build outputs.
//
//   node scripts/ci/turbo-cache.mjs verify   fails when a task other than a build was replayed
//   node scripts/ci/turbo-cache.mjs prune    deletes every cache entry but this job's builds
//
// Both read the run summaries that turbo writes to .turbo/runs when TURBO_RUN_SUMMARY is true.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Reads the tasks of the run summaries in `runs`, each task as of the earliest run that
 * scheduled it. Throws when there is no summary.
 */
export const summaryTasks = (runs) => {
  const files = existsSync(runs) ? readdirSync(runs).filter((name) => name.endsWith(".json")) : [];
  if (files.length === 0) throw new Error(`No turbo run summary in ${runs}`);
  const tasks = new Map();
  const summaries = files
    .map((name) => JSON.parse(readFileSync(join(runs, name), "utf8")))
    .sort((a, b) => a.execution.startTime - b.execution.startTime);
  for (const summary of summaries) {
    for (const task of summary.tasks) if (!tasks.has(task.taskId)) tasks.set(task.taskId, task);
  }
  return [...tasks.values()];
};

/** Returns the tasks that turbo replayed from its cache although they are not builds. */
export const replayedChecks = (tasks) =>
  tasks.filter(({ task, cache }) => task !== "build" && cache.status === "HIT");

/**
 * Deletes the cache entries (`<hash>.tar.zst`, `<hash>-meta.json`, `<hash>-manifest.json`) whose
 * hash is not one of `tasks`' builds. Returns the deleted and kept byte counts.
 */
export const prune = (cache, tasks) => {
  const keep = new Set(tasks.filter(({ task }) => task === "build").map(({ hash }) => hash));
  const bytes = { deleted: 0, kept: 0 };
  for (const name of existsSync(cache) ? readdirSync(cache) : []) {
    const path = join(cache, name);
    const size = statSync(path).size;
    const hash = /^([0-9a-f]{16})(?:\.tar\.zst|-meta\.json|-manifest\.json)$/u.exec(name)?.[1];
    if (hash !== undefined && keep.has(hash)) {
      bytes.kept += size;
    } else {
      rmSync(path, { recursive: true, force: true });
      bytes.deleted += size;
    }
  }
  return bytes;
};

const main = (command) => {
  const turbo = fileURLToPath(new URL("../../.turbo/", import.meta.url));
  const runs = join(turbo, "runs");
  const tasks = summaryTasks(runs);
  if (command === "verify") {
    const replayed = replayedChecks(tasks);
    const builds = tasks.filter(({ task }) => task === "build");
    const hits = builds.filter(({ cache }) => cache.status === "HIT").length;
    const others = tasks.length - builds.length;
    console.log(
      `Builds: ${hits} of ${builds.length} from the cache. Checks and tests: ${others - replayed.length} of ${others} executed.`,
    );
    if (replayed.length > 0) {
      for (const { taskId } of replayed)
        console.error(`::error::${taskId} was replayed from the turbo cache instead of run`);
      process.exitCode = 1;
    }
  } else if (command === "prune") {
    const { deleted, kept } = prune(join(turbo, "cache"), tasks);
    rmSync(runs, { recursive: true, force: true });
    console.log(
      `Turbo cache: kept ${(kept / 1e6).toFixed(1)} MB of builds, deleted ${(deleted / 1e6).toFixed(1)} MB.`,
    );
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv[2]);
