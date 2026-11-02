import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const checker = fileURLToPath(new URL("./check.mjs", import.meta.url));

test("docs gate accepts present-tense pages and reports history in nested Markdown and MDX", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "usine-docs-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "guides"));
  await writeFile(
    join(root, "guides", "current.md"),
    "# Start a run\nOpen /reference/#settings.\n",
  );
  const clean = spawnSync(process.execPath, [checker, root], { encoding: "utf8" });
  assert.equal(clean.status, 0, clean.stderr);

  await writeFile(join(root, "guides", "fixture.mdx"), "---\ntitle: Fixture\n---\nSee #123.\n");
  const issue = spawnSync(process.execPath, [checker, root], { encoding: "utf8" });
  assert.equal(issue.status, 1);
  assert.match(issue.stderr, /fixture\.mdx:4:.*#123/u);

  await writeFile(
    join(root, "guides", "history.md"),
    "ADR\nno longer\nused to\nPreviously\nno\nlonger\n",
  );
  const history = spawnSync(process.execPath, [checker, root], { encoding: "utf8" });
  assert.equal(history.status, 1);
  for (const phrase of ["ADR", "no longer", "used to", "Previously"]) {
    assert.ok(history.stderr.includes(phrase), history.stderr);
  }
  assert.match(history.stderr, /history\.md:5:.*no\nlonger/u);
});
