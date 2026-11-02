import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { redirects } from "../redirects.mjs";

for (const filename of ["llms.txt", "llms-full.txt", "llms-small.txt"]) {
  test(`${filename} publishes docs in sidebar order with site metadata`, async () => {
    const text = await readFile(new URL(`../dist/${filename}`, import.meta.url), "utf8");
    assert.match(text, /^# usine\n\n> usine runs coding agents .*\./);
    const labels = [
      "Overview",
      "Quickstart",
      "Concepts",
      "Add a local worker",
      "Add a Boat worker",
      "Add a Hetzner worker",
      "CLI",
      "Settings",
      "Workers",
      "Loops",
    ].map((title) => (filename === "llms.txt" ? `[${title}]` : `\n# ${title}\n`));
    let previous = -1;
    for (const label of labels) {
      const position = text.indexOf(label);
      assert.ok(position > previous, `${label} must appear after the preceding sidebar page`);
      previous = position;
    }
    assert.ok(!text.includes("<!-- llms-page -->"));
    for (const [, href] of text.matchAll(/\]\((https:\/\/docs\.usine\.dev\/[^)]+)\)/g)) {
      const route = new URL(href).pathname.replace(/\/$/, "");
      assert.ok(!(route in redirects), `redirect ${route} is excluded`);
      assert.ok(!route.startsWith("/architecture"), `architecture page ${route} is excluded`);
    }
  });
}
