import assert from "node:assert/strict";
import { spawn, execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  existsSync,
  readdirSync,
  openSync,
  closeSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync, backup } from "node:sqlite";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

assert(
  process.argv.length === 5 || (process.argv.length === 6 && process.argv[5] === "--large-only"),
  "usage: measure.mjs REPO NEW_DIRECTORY LITESTREAM [--large-only]",
);
const [repo, root, binary] = process.argv.slice(2, 5).map((p) => resolve(p));
const largeOnly = process.argv[5] === "--large-only";
mkdirSync(root, { recursive: false });
const exec = promisify(execFile);
const env = { ...process.env, GOMAXPROCS: "1", GOMEMLIMIT: "256MiB" };
const results = {
  node: process.version,
  sqlite: new DatabaseSync(":memory:").prepare("select sqlite_version() v").get().v,
  env: { GOMAXPROCS: env.GOMAXPROCS, GOMEMLIMIT: env.GOMEMLIMIT },
};
const save = (key, value) => {
  results[key] = value;
  writeFileSync(join(root, "results.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(key, JSON.stringify(value));
};
const bytes = (p) => (existsSync(p) ? statSync(p).size : 0);
const treeBytes = (p) =>
  !existsSync(p)
    ? 0
    : readdirSync(p, { withFileTypes: true }).reduce(
        (n, e) => n + (e.isDirectory() ? treeBytes(join(p, e.name)) : bytes(join(p, e.name))),
        0,
      );
const timed = async (name, args) => {
  const out = join(root, `${name}.time.txt`);
  const start = performance.now();
  await exec("timeout", ["--signal=KILL", "175", "time", "-v", "-o", out, binary, ...args], {
    env: { ...env, LC_ALL: "C" },
    timeout: 180000,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
  });
  const wall = (performance.now() - start) / 1000;
  const usage = readFileSync(out, "utf8");
  const value = (label) =>
    Number(
      usage
        .split("\n")
        .find((line) => line.trimStart().startsWith(label))
        .split(":")
        .at(-1),
    );
  return {
    wall_s: wall,
    user_s: value("User time (seconds):"),
    system_s: value("System time (seconds):"),
    max_rss_kib: value("Maximum resident set size (kbytes):"),
  };
};
const startReplica = async (dir, paths) => {
  const socketDirectory = mkdtempSync(join(tmpdir(), "usine-ls-"));
  const socket = join(socketDirectory, "control.sock");
  const config = join(dir, "litestream.yml");
  writeFileSync(
    config,
    `socket:\n  enabled: true\n  path: ${socket}\ndbs:\n` +
      paths
        .map((p) => `  - path: ${p}\n    replica:\n      type: file\n      path: ${p}.replica\n`)
        .join(""),
  );
  const log = openSync(join(dir, "litestream.log"), "w");
  const child = spawn(binary, ["replicate", "-config", config], {
    env,
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  const done = once(child, "exit");
  for (let i = 0; i < 300 && !existsSync(socket); i++) {
    assert.equal(child.exitCode, null, "replicator exited");
    await delay(100);
  }
  if (!existsSync(socket)) {
    child.kill("SIGTERM");
    await done;
    rmSync(socketDirectory, { recursive: true, force: true });
    throw new Error("control socket ready timeout; inspect litestream.log");
  }
  const sync = async (path) =>
    JSON.parse(
      (
        await exec(binary, ["sync", "-socket", socket, "-wait", "-timeout", "120", "-json", path], {
          env,
          timeout: 125000,
        })
      ).stdout,
    );
  const stop = async () => {
    child.kill("SIGTERM");
    const [code] = await done;
    assert.equal(code, 0);
    rmSync(socketDirectory, { recursive: true, force: true });
  };
  return { child, sync, stop };
};
const settings = (db) =>
  Object.fromEntries(
    ["journal_mode", "synchronous", "wal_autocheckpoint", "busy_timeout", "page_size"].map((p) => [
      p,
      Object.values(db.prepare(`PRAGMA ${p}`).get())[0],
    ]),
  );
const requireEngine = createRequire(join(repo, "packages/engine/package.json"));
const { Effect } = await import(requireEngine.resolve("effect"));
const { SqliteClient } = await import(requireEngine.resolve("@effect/sql-sqlite-node"));
const actual = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* SqliteClient.SqliteClient;
      const out = {};
      for (const p of [
        "journal_mode",
        "synchronous",
        "wal_autocheckpoint",
        "busy_timeout",
        "page_size",
      ])
        out[p] = yield* client.unsafe(`PRAGMA ${p}`);
      return out;
    }).pipe(Effect.provide(SqliteClient.layer({ filename: join(root, "effect.sqlite") }))),
  ),
);
save("effect_settings", actual);
const requireDurable = createRequire(join(repo, "packages/durable/package.json"));
const { openNodeSqliteDatabase } = await import(
  requireDurable.resolve("@earendil-works/pi-durable/storage/sqlite/node")
);
const durable = await openNodeSqliteDatabase(join(root, "pi.sqlite"));
const piSettings = {};
for (const p of ["journal_mode", "synchronous", "wal_autocheckpoint", "busy_timeout", "page_size"])
  piSettings[p] = await durable.get(`PRAGMA ${p}`);
await durable.close();
save("pi_settings", piSettings);

save("measurement", {
  mode: largeOnly ? "large-only" : "full",
  cpu_affinity: readFileSync("/proc/self/status", "utf8").match(/^Cpus_allowed_list:\s+(.+)$/m)[1],
  memory_max_bytes: Number(readFileSync("/sys/fs/cgroup/memory.max", "utf8")),
  memory_swap_max_bytes: Number(readFileSync("/sys/fs/cgroup/memory.swap.max", "utf8")),
  replication_rss_method: "ps -o rss= -p PID, sampled every 100 ms across replication and restores",
  restore_rss_method: "GNU time -v: Maximum resident set size (kbytes)",
});

for (const mode of largeOnly ? [] : ["baseline", "auto1000", "auto0", "pi-auto1000", "pi-auto0"]) {
  const dir = join(root, mode);
  mkdirSync(dir);
  const path = join(dir, "runtime.sqlite");
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec(
    `PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=${mode.endsWith("auto0") ? 0 : 1000}; CREATE TABLE transcript(id INTEGER PRIMARY KEY,payload BLOB); CREATE TABLE runs(id INTEGER PRIMARY KEY,n INTEGER); INSERT INTO runs VALUES(1,0)`,
  );
  if (mode.startsWith("pi-")) db.exec("PRAGMA synchronous=NORMAL");
  const replica = mode === "baseline" ? null : await startReplica(dir, [path]);
  if (replica) await replica.sync(path);
  const insert = db.prepare("INSERT INTO transcript(payload) VALUES(?)");
  const payload = randomBytes(2048);
  const latency = [];
  const samples = [];
  const sample = () => {
    const row = { at_ms: performance.now(), wal_bytes: bytes(path + "-wal") };
    if (replica) {
      const status = readFileSync(`/proc/${replica.child.pid}/status`, "utf8");
      row.rss_kib = Number(status.match(/^VmRSS:\s+(\d+)/m)[1]);
      const stat = readFileSync(`/proc/${replica.child.pid}/stat`, "utf8").split(" ");
      row.cpu_ticks = Number(stat[13]) + Number(stat[14]);
    }
    samples.push(row);
  };
  const timer = setInterval(sample, 100);
  let commits = 0;
  let reader;
  const write = () => {
    const t = performance.now();
    db.exec("BEGIN IMMEDIATE");
    insert.run(payload);
    db.exec("UPDATE runs SET n=n+1 WHERE id=1; COMMIT");
    latency.push(performance.now() - t);
    commits++;
  };
  const phases = [];
  try {
    for (const [phase, seconds, batch, pause] of [
      ["steady", 60, 1, 50],
      ["burst_with_reader", 10, 100, 200],
      ["reader_released", 5, 1, 50],
    ]) {
      if (phase === "burst_with_reader") {
        reader = new DatabaseSync(path);
        reader.exec("BEGIN");
        reader.prepare("SELECT count(*) FROM transcript").get();
      }
      if (phase === "reader_released") {
        reader.close();
        reader = undefined;
      }
      const start = performance.now();
      const before = commits;
      const firstSample = samples.length;
      while (performance.now() - start < seconds * 1000) {
        for (let i = 0; i < batch; i++) write();
        await delay(pause);
      }
      phases.push({
        phase,
        elapsed_s: (performance.now() - start) / 1000,
        commits: commits - before,
        wal_max_bytes: Math.max(...samples.slice(firstSample).map((s) => s.wal_bytes)),
      });
      console.log(mode, phase, phases.at(-1).commits);
    }
    const marker = replica ? await replica.sync(path) : null;
    sample();
    if (replica) {
      assert(marker.replica_txid >= marker.txid);
      const restored = join(dir, "restored.sqlite");
      await timed(`${mode}-restore`, [
        "restore",
        "-o",
        restored,
        "-txid",
        marker.txid.toString(16).padStart(16, "0"),
        `file://${path}.replica`,
      ]);
      const check = new DatabaseSync(restored);
      assert.equal(check.prepare("SELECT count(*) n FROM transcript").get().n, commits);
      assert.equal(check.prepare("SELECT n FROM runs").get().n, commits);
      assert.equal(check.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      check.close();
    }
    latency.sort((a, b) => a - b);
    save(mode, {
      settings: settings(db),
      phases,
      commits,
      p50_ms: latency[Math.floor(latency.length * 0.5)],
      p99_ms: latency[Math.floor(latency.length * 0.99)],
      max_ms: latency.at(-1),
      wal_max_bytes: Math.max(...samples.map((s) => s.wal_bytes)),
      wal_final_bytes: bytes(path + "-wal"),
      replica_bytes: treeBytes(path + ".replica"),
      rss_max_kib: replica ? Math.max(...samples.map((s) => s.rss_kib)) : null,
      cpu_s: replica ? samples.at(-1).cpu_ticks / 100 : null,
      marker,
    });
    writeFileSync(join(dir, "samples.json"), JSON.stringify(samples));
  } finally {
    clearInterval(timer);
    if (reader) reader.close();
    if (replica) await replica.stop();
    db.close();
  }
}

const big = join(root, "large");
mkdirSync(big);
const paths = [];
for (const [name, rows] of [
  ["runtime", 191998],
  ["durable", 38398],
]) {
  const path = join(big, name + ".sqlite");
  paths.push(path);
  const db = new DatabaseSync(path);
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE content(id INTEGER PRIMARY KEY,payload BLOB); CREATE TABLE marker(version TEXT); INSERT INTO marker VALUES('before')",
  );
  const ins = db.prepare("INSERT INTO content(payload) VALUES(randomblob(3900))");
  for (let start = 0; start < rows; start += 1000) {
    db.exec("BEGIN");
    for (let i = start; i < Math.min(start + 1000, rows); i++) ins.run();
    db.exec("COMMIT");
  }
  db.exec("DELETE FROM content WHERE id % 4=0; PRAGMA wal_checkpoint(TRUNCATE)");
  const t = performance.now();
  await backup(db, join(big, name + ".backup.sqlite"));
  save(name + "_fixture", {
    bytes: bytes(path),
    backup_bytes: bytes(join(big, name + ".backup.sqlite")),
    backup_s: (performance.now() - t) / 1000,
    page_count: db.prepare("PRAGMA page_count").get().page_count,
    freelist_count: db.prepare("PRAGMA freelist_count").get().freelist_count,
    rows: db.prepare("SELECT count(*) n FROM content").get().n,
  });
  db.close();
}
const t = performance.now();
const replica = await startReplica(big, paths);
const largeSamples = [];
const sampleLarge = () => {
  const stat = readFileSync(`/proc/${replica.child.pid}/stat`, "utf8").split(" ");
  largeSamples.push({
    rss_kib: Number(
      execFileSync("ps", ["-o", "rss=", "-p", String(replica.child.pid)], {
        encoding: "utf8",
      }).trim(),
    ),
    cpu_ticks: Number(stat[13]) + Number(stat[14]),
  });
};
sampleLarge();
const largeTimer = setInterval(sampleLarge, 100);
try {
  const markers = [];
  for (const path of paths) markers.push(await replica.sync(path));
  save("initial_replication", {
    wall_s: (performance.now() - t) / 1000,
    markers,
    replica_bytes: paths.map((p) => treeBytes(p + ".replica")),
    rss_max_kib: Math.max(...largeSamples.map((s) => s.rss_kib)),
    cpu_s: largeSamples.at(-1).cpu_ticks / 100,
  });
  // All writers are stopped at this boundary. Each file has its own confirmed TXID.
  const boundary = new Date().toISOString();
  await delay(1500);
  for (const path of paths) {
    const db = new DatabaseSync(path);
    db.exec("UPDATE marker SET version='after'; ALTER TABLE marker ADD COLUMN migrated INTEGER");
    db.close();
    await replica.sync(path);
  }
  const attempts = [];
  for (let i = 0; i < 3; i++) {
    const pair = [];
    for (let j = 0; j < paths.length; j++) {
      const out = join(big, `restore-${i}-${j}.sqlite`);
      const time = await timed(`large-${i}-${j}`, [
        "restore",
        "-o",
        out,
        "-txid",
        markers[j].txid.toString(16).padStart(16, "0"),
        "-integrity-check",
        "quick",
        `file://${paths[j]}.replica`,
      ]);
      const db = new DatabaseSync(out);
      assert.equal(db.prepare("SELECT version FROM marker").get().version, "before");
      assert.equal(
        db.prepare("SELECT count(*) n FROM pragma_table_info('marker') WHERE name='migrated'").get()
          .n,
        0,
      );
      const verifyStart = performance.now();
      assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      pair.push({
        ...time,
        full_integrity_s: (performance.now() - verifyStart) / 1000,
        bytes: bytes(out),
      });
      db.close();
    }
    attempts.push(pair);
  }
  const timestampOut = join(big, "timestamp.sqlite");
  const timestampTime = await timed("timestamp", [
    "restore",
    "-o",
    timestampOut,
    "-timestamp",
    boundary,
    `file://${paths[0]}.replica`,
  ]);
  const db = new DatabaseSync(timestampOut);
  assert.equal(db.prepare("SELECT version FROM marker").get().version, "before");
  db.close();
  save("rollback", {
    boundary,
    markers,
    attempts,
    timestamp_wall_s: timestampTime.wall_s,
    timestamp_max_rss_kib: timestampTime.max_rss_kib,
    exact_txid_and_timestamp_verified: true,
  });
  sampleLarge();
  save("large_replication", {
    rss_max_kib: Math.max(...largeSamples.map((s) => s.rss_kib)),
    cpu_s: largeSamples.at(-1).cpu_ticks / 100,
    sample_count: largeSamples.length,
  });
  writeFileSync(join(big, "samples.json"), JSON.stringify(largeSamples));
} finally {
  clearInterval(largeTimer);
  await replica.stop();
}
