import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.argv[2] ?? new URL("../../apps/docs/src/content/docs/", import.meta.url);
const history = /#\d+\b|\bADR\b|\bno\s+longer\b|\bused\s+to\b|\bpreviously\b/giu;
let failures = 0;

for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !/\.mdx?$/u.test(entry.name)) continue;
  const file = resolve(entry.parentPath, entry.name);
  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(history)) {
    const line = source.slice(0, match.index).split(/\r?\n/u).length;
    console.error(`${file}:${line}: describe the current product: ${match[0]}`);
    failures++;
  }
}

if (failures > 0) process.exitCode = 1;
else console.log("Docs describe the current product.");
