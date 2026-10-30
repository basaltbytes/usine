import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { publishNext } from "./next.mjs";

const tlogConflict = {
  code: 1,
  output:
    "[TLOG_CREATE_ENTRY_ERROR] error creating tlog entry - (409) an equivalent entry already exists",
};
const stagedConflict = {
  code: 1,
  output: '[E409] Cannot publish over previously staged version "1.0.1"',
};
const success = { code: 0, output: "Published", lag: 0 };
const lagging = { code: 0, output: "Published", lag: 4 };
const neverPublic = { code: 0, output: "Published", lag: Infinity };

function events(t) {
  const logged = [];
  t.mock.method(console, "log", (line) => logged.push(JSON.parse(line)));
  return logged;
}

async function fixture(t, outcomes) {
  const directory = await mkdtemp(join(tmpdir(), "usine-next-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packages = [];
  for (const [name, version] of [
    ["@usine-test/core", "1.0.0"],
    ["@usine-test/app", "2.3.4"],
  ]) {
    const file = join(directory, `${name.split("/")[1]}.json`);
    const manifest = { name, version };
    await writeFile(file, JSON.stringify(manifest));
    packages.push({ file, manifest });
  }
  const visible = new Map();
  const staged = new Set();
  let unrevealed = [];
  let lag = 0;
  const reveal = () => {
    for (const manifest of unrevealed)
      visible.set(`/${manifest.name}/${manifest.version}`, manifest);
    unrevealed = [];
  };
  const server = createServer((request, response) => {
    const manifest = visible.get(decodeURIComponent(request.url));
    response.writeHead(manifest ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(manifest ?? { error: "Not found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const registry = `http://127.0.0.1:${server.address().port}/`;
  const builds = [];
  const publishes = [];
  const delays = [];
  const manifests = () =>
    Promise.all(packages.map(async ({ file }) => JSON.parse(await readFile(file, "utf8"))));
  const command = async (args) => {
    const current = await manifests();
    if (args[0] === "build") {
      builds.push(current);
      return success;
    }
    assert.deepEqual(args, ["-r", "publish", "--tag", "next", "--no-git-checks", "--provenance"]);
    publishes.push(current);
    if (current.some(({ name, version }) => staged.has(`${name}@${version}`)))
      return stagedConflict;
    const outcome = outcomes.shift() ?? success;
    if (outcome.code !== 0) {
      const [first] = current;
      staged.add(`${first.name}@${first.version}`);
    }
    if (outcome.code === 0) {
      unrevealed = current;
      lag = outcome.lag;
      if (lag === 0) reveal();
    }
    return outcome;
  };
  const input = { run: "312", sha: "1a2b3c4", runAttempt: "1", packages };
  const services = {
    command,
    wait: async (ms) => {
      delays.push(ms);
      if (unrevealed.length > 0 && --lag === 0) reveal();
    },
    registry,
  };
  return { input, services, builds, publishes, delays, visible };
}

for (const [label, failure] of [
  ["Sigstore 409", tlogConflict],
  ["staged version", stagedConflict],
]) {
  test(`recovers from a ${label} conflict with a rebuilt, complete snapshot`, async (t) => {
    const f = await fixture(t, [failure, success]);
    await publishNext(f.input, f.services);
    assert.equal(f.publishes.length, 2);
    assert.deepEqual(f.builds, f.publishes);
    assert.deepEqual(f.delays, [15_000]);
    assert.deepEqual(
      f.publishes.map((packages) => packages.map(({ version }) => version)),
      [
        ["1.0.1-next.312.g1a2b3c4.1.1", "2.3.5-next.312.g1a2b3c4.1.1"],
        ["1.0.1-next.312.g1a2b3c4.1.2", "2.3.5-next.312.g1a2b3c4.1.2"],
      ],
    );
    assert.equal(f.visible.size, 2);
  });
}

test("rebuilds fresh versions when a TLOG retry encounters another staged conflict", async (t) => {
  const f = await fixture(t, [tlogConflict, stagedConflict, success]);
  await publishNext(f.input, f.services);
  assert.equal(f.publishes.length, 3);
  assert.deepEqual(f.delays, [15_000, 30_000]);
  assert.equal(new Set(f.publishes.flat().map(({ version }) => version)).size, 6);
  assert.equal(f.visible.size, 2);
});

test("a GitHub job rerun uses new versions without changing the next patch", async (t) => {
  const f = await fixture(t, [success, success]);
  await publishNext(f.input, f.services);
  await publishNext({ ...f.input, runAttempt: "2" }, f.services);
  assert.equal(f.publishes[1][0].version, "1.0.1-next.312.g1a2b3c4.2.1");
});

test("stops after three transient failures", async (t) => {
  const f = await fixture(t, [tlogConflict, tlogConflict, tlogConflict]);
  await assert.rejects(publishNext(f.input, f.services), /failed after 3 attempts/);
  assert.equal(f.publishes.length, 3);
  assert.deepEqual(f.delays, [15_000, 30_000]);
});

test("does not retry authorization errors, unrelated conflicts, or other Sigstore failures", async (t) => {
  for (const output of [
    "[E403] Forbidden",
    "[E409] Version exists",
    "[TLOG_CREATE_ENTRY_ERROR] (500) unavailable",
  ]) {
    const f = await fixture(t, [{ code: 1, output }]);
    await assert.rejects(publishNext(f.input, f.services), /Snapshot publish failed/);
    assert.equal(f.publishes.length, 1);
    assert.deepEqual(f.delays, []);
  }
});

test("a build failure stops before publishing", async (t) => {
  const f = await fixture(t, []);
  await assert.rejects(
    publishNext(f.input, {
      ...f.services,
      command: async () => ({ code: 1, output: "Build failed" }),
    }),
    /Snapshot build failed/,
  );
  assert.deepEqual(f.publishes, []);
});

test("waits for a successful upload to become public without republishing", async (t) => {
  const f = await fixture(t, [lagging]);
  const logged = events(t);
  await publishNext(f.input, f.services);
  assert.equal(f.publishes.length, 1);
  assert.deepEqual(f.delays, [10_000, 15_000, 20_000, 25_000]);
  assert.equal(f.visible.size, 2);
  assert.ok(!logged.some(({ event }) => event === "next_publish_retry"));
  assert.deepEqual(logged.at(-1), {
    event: "next_publish_completed",
    attempt: 1,
    suffix: "next.312.g1a2b3c4.1.1",
    check: 5,
    waitedMs: 70_000,
  });
});

test("fails without republishing when a successful upload stays private for ten minutes", async (t) => {
  const f = await fixture(t, [neverPublic]);
  const logged = events(t);
  await assert.rejects(publishNext(f.input, f.services), /not public after 10 minutes/);
  assert.equal(f.publishes.length, 1);
  assert.deepEqual(f.delays.slice(0, 6), [10_000, 15_000, 20_000, 25_000, 30_000, 30_000]);
  assert.equal(
    f.delays.reduce((total, ms) => total + ms, 0),
    600_000,
  );
  assert.ok(!logged.some(({ event }) => event === "next_publish_retry"));
  assert.deepEqual(logged.at(-1), {
    event: "next_publish_exhausted",
    attempt: 1,
    suffix: "next.312.g1a2b3c4.1.1",
    reason: "versions_not_public",
    waitedMs: 600_000,
    packages: [
      "@usine-test/core@1.0.1-next.312.g1a2b3c4.1.1",
      "@usine-test/app@2.3.5-next.312.g1a2b3c4.1.1",
    ],
  });
});
