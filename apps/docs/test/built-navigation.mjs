import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fromHtml } from "hast-util-from-html";
import { toString } from "hast-util-to-string";
import { visit } from "unist-util-visit";
import { guideGroups } from "../sidebar.mjs";

const tree = fromHtml(
  await readFile(new URL("../dist/guides/overview/index.html", import.meta.url), "utf8"),
);

for (const target of ["sidebar", "drawer"]) {
  test(`${target} renders every task group as a disclosure with all its guide links`, () => {
    const containers = [];
    visit(tree, "element", (node) => {
      if (node.properties.id === target || node.properties.className?.includes(target)) {
        containers.push(node);
      }
    });
    assert.equal(containers.length, 1);
    const [container] = containers;
    for (const group of guideGroups) {
      const matches = [];
      visit(container, "element", (node) => {
        if (
          node.tagName === "details" &&
          node.children.some(
            (child) =>
              child.type === "element" &&
              child.tagName === "summary" &&
              toString(child).trim() === group.label,
          )
        ) {
          matches.push(node);
        }
      });
      assert.equal(matches.length, 1, group.label);
      const [disclosure] = matches;
      const links = [];
      visit(disclosure, "element", (node) => {
        if (node.tagName === "a") links.push(node.properties.href);
      });
      assert.deepEqual(
        links,
        group.items.map(({ slug }) => `/${slug}/`),
        group.label,
      );
    }
  });
}
