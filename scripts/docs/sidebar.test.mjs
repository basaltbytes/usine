import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { guideGroups } from "../../apps/docs/sidebar.mjs";

const root = new URL("../../apps/docs/src/content/docs/", import.meta.url);

test("the task sidebar includes every guide exactly once", async () => {
  const files = (await readdir(new URL("guides/", root), { recursive: true }))
    .filter((file) => /\.mdx?$/u.test(file))
    .map((file) => `guides/${file.replace(/\.mdx?$/u, "")}`);
  const slugs = [
    "guides/overview",
    ...guideGroups.flatMap(({ items }) => items.map(({ slug }) => slug)),
  ];

  assert.deepEqual(slugs.toSorted(), files.toSorted());
});

test("each collapsible task group starts with an overview linking to all its guides", async () => {
  assert.deepEqual(
    guideGroups.map(({ label }) => label),
    ["Run usine", "Workers", "Loops and agents", "Work with runs", "Access"],
  );
  for (const group of guideGroups) {
    assert.equal(group.collapsed, true);
    const [overview, ...guides] = group.items;
    const source = await readFile(new URL(`${overview.slug}.md`, root), "utf8");
    for (const guide of guides) {
      assert.ok(source.includes(`](/${guide.slug}/)`), `${group.label} omits ${guide.slug}`);
    }
  }
});
