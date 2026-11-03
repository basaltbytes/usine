// Applies the Effect autofixes in tooling/oxlint/effect-fix.json until a pass reports no fixable
// diagnostic, then formats the repository. Overlapping fixes in one pass leave some for the next.
// Usage, from the repository root: node scripts/effect-diagnostics/fix.mjs [paths...]
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const bin = (name) => resolve(root, "node_modules/.bin", name);
const paths = process.argv.slice(2);
const maxPasses = 5;

const pass = () => {
  const result = spawnSync(
    bin("effect-tsgo"),
    ["oxlint", "-c", "tooling/oxlint/effect-fix.json", "--fix-suggestions", ...paths],
    { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.error !== undefined) throw result.error;
  return (result.stdout.match(/ effecttsgo\(/gu) ?? []).length;
};

let remaining = pass();
for (let count = 1; remaining > 0 && count < maxPasses; count++) {
  console.log(`Pass ${count} left ${remaining} fixable diagnostics.`);
  remaining = pass();
}
if (remaining > 0) {
  console.error(`${remaining} fixable diagnostics remain after ${maxPasses} passes.`);
  process.exit(1);
}
const format = spawnSync(bin("oxfmt"), [], { cwd: root, stdio: "inherit" });
process.exit(format.status ?? 1);
