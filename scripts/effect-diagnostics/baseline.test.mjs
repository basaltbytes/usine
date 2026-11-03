import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fromDocument, raises, shrink, toDocument } from "./baseline.mjs";

const differ = fileURLToPath(new URL("./diff.mjs", import.meta.url));

const shrunk = (baseline, current) => {
  const { next, uncovered } = shrink(fromDocument(baseline), fromDocument(current));
  return { next: toDocument(next), uncovered };
};

test("a renamed or split file keeps its allowance, and the baseline never rises", () => {
  const baseline = { "src/old.ts": { newSchemaClass: 5, globalJson: 1 } };

  const renamed = shrunk(baseline, { "src/new.ts": { newSchemaClass: 5, globalJson: 1 } });
  assert.deepEqual(renamed, {
    next: { "src/new.ts": { globalJson: 1, newSchemaClass: 5 } },
    uncovered: [],
  });

  const split = shrunk(baseline, {
    "src/old.ts": { newSchemaClass: 3 },
    "src/part.ts": { newSchemaClass: 2, globalJson: 1 },
  });
  assert.deepEqual(split.uncovered, []);
  assert.deepEqual(split.next, {
    "src/old.ts": { newSchemaClass: 3 },
    "src/part.ts": { globalJson: 1, newSchemaClass: 2 },
  });

  for (const { next } of [renamed, split])
    assert.deepEqual(raises(fromDocument(baseline), fromDocument(next)), []);
});

test("a deleted file drops its entries", () => {
  assert.deepEqual(
    shrunk(
      { "src/gone.ts": { newSchemaClass: 2 }, "src/kept.ts": { globalJson: 1 } },
      {
        "src/kept.ts": { globalJson: 1 },
      },
    ),
    { next: { "src/kept.ts": { globalJson: 1 } }, uncovered: [] },
  );
});

test("violations that no released count covers stay uncovered", () => {
  const added = shrunk(
    { "src/a.ts": { globalJson: 1 } },
    {
      "src/a.ts": { globalJson: 1 },
      "src/b.ts": { globalJson: 1, newPromise: 1 },
    },
  );
  assert.deepEqual(added.uncovered, [
    { rule: "globalJson", file: "src/b.ts", count: 1, allowed: 0 },
    { rule: "newPromise", file: "src/b.ts", count: 1, allowed: 0 },
  ]);

  const mergedIntoListed = shrunk(
    { "src/a.ts": { globalJson: 1 }, "src/b.ts": { globalJson: 1 } },
    { "src/b.ts": { globalJson: 2 } },
  );
  assert.deepEqual(mergedIntoListed.uncovered, [
    { rule: "globalJson", file: "src/b.ts", count: 2, allowed: 1 },
  ]);
});

test("raises reports a higher file count, a higher rule total, and a new rule", () => {
  const base = fromDocument({ "src/a.ts": { globalJson: 2 } });
  assert.deepEqual(raises(base, fromDocument({ "src/a.ts": { globalJson: 3 } })), [
    { rule: "globalJson", file: "src/a.ts", before: 2, after: 3 },
    { rule: "globalJson", before: 2, after: 3 },
  ]);
  assert.deepEqual(
    raises(base, fromDocument({ "src/a.ts": { globalJson: 2 }, "src/b.ts": { globalJson: 1 } })),
    [{ rule: "globalJson", before: 2, after: 3 }],
  );
  assert.deepEqual(raises(base, fromDocument({ "src/a.ts": { globalJson: 2, newPromise: 1 } })), [
    { rule: "newPromise", before: 0, after: 1 },
  ]);
});

test("diff.mjs passes the first baselines and a rename, and fails a raised count", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "usine-effect-diff-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const commit = async (document) => {
    await writeFile(join(root, "pkg", "effect-baseline.json"), JSON.stringify(document));
    git("add", "-A");
    git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "baseline");
  };
  const diff = () =>
    spawnSync(process.execPath, [differ, "HEAD~1"], { cwd: root, encoding: "utf8" });

  git("init", "-q");
  await mkdir(join(root, "pkg"));
  await writeFile(join(root, "README"), "fixture\n");
  git("add", "-A");
  git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "start");

  await commit({ "src/a.ts": { globalJson: 2 } });
  assert.equal(diff().status, 0, diff().stderr);

  await commit({ "src/b.ts": { globalJson: 2 } });
  assert.equal(diff().status, 0, diff().stderr);

  await commit({ "src/b.ts": { globalJson: 3 } });
  const raised = diff();
  assert.equal(raised.status, 1);
  assert.match(raised.stderr, /globalJson src\/b\.ts rose from 2 to 3/u);
});
