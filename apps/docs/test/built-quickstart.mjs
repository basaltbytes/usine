import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fromHtml } from "hast-util-from-html";
import { toString } from "hast-util-to-string";
import { visit } from "unist-util-visit";
import { quickstartRoutes } from "../src/quickstart/routes.ts";

const tree = fromHtml(
  await readFile(new URL("../dist/get-started/quickstart/index.html", import.meta.url), "utf8"),
);

/** Returns the text of each copy button in `node`; Expressive Code separates lines with U+007F. */
const copiedCode = (node) => {
  const code = [];
  visit(node, "element", (element) => {
    if (element.tagName === "button" && element.properties.dataCode !== undefined) {
      code.push(String(element.properties.dataCode).replaceAll("\u007f", "\n"));
    }
  });
  return code;
};

test("each bootstrap tab shows the developer agent of its own route", () => {
  const groups = [];
  visit(tree, "element", (node) => {
    if (
      node.tagName === "starlight-tabs" &&
      copiedCode(node).some((code) => code.includes("cat > agents/developer.md"))
    ) {
      groups.push(node);
    }
  });
  assert.equal(groups.length, 1);
  const [group] = groups;
  const labels = [];
  const panels = [];
  visit(group, "element", (node) => {
    if (node.properties.role === "tab") labels.push(toString(node).trim());
    if (node.properties.role === "tabpanel") panels.push(node);
  });
  assert.deepEqual(
    labels,
    quickstartRoutes.map(({ label }) => label),
  );
  assert.equal(panels.length, quickstartRoutes.length);
  quickstartRoutes.forEach((route, index) => {
    const code = copiedCode(panels[index]);
    assert.equal(code.length, 1, route.label);
    const agent = code[0].match(/^cat > agents\/developer\.md <<'AGENT'\n([\s\S]*?)\nAGENT$/mu);
    assert.ok(agent, route.label);
    assert.match(agent[1], new RegExp(`^harness: ${route.harness}$`, "mu"), route.label);
    assert.match(
      agent[1],
      new RegExp(`^model: ${route.model.replaceAll(/[./]/gu, "\\$&")}$`, "mu"),
      route.label,
    );
  });
});
