import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const lint = (filename, source) => {
  const probe = join(root, filename.replace("example.ts", `web-import-probe-${process.pid}.ts`));
  writeFileSync(probe, source, { flag: "wx" });
  try {
    return spawnSync("pnpm", ["exec", "oxlint", probe], { cwd: root, encoding: "utf8" });
  } finally {
    rmSync(probe);
  }
};

for (const [name, filename, source, rule] of [
  [
    "type-query imports across features",
    "features/tasks/example.ts",
    'export type Result = import("~/features/runs/example").Result;',
    "web-import-direction",
  ],
  [
    "cross-feature imports",
    "features/tasks/example.ts",
    'import "~/features/runs/example";',
    "web-import-direction",
  ],
  [
    "shared imports of features",
    "components/example.ts",
    'export * from "~/features/runs/example";',
    "web-import-direction",
  ],
  [
    "feature imports of routes",
    "features/runs/example.ts",
    'import "~/routes/index";',
    "web-import-direction",
  ],
  [
    "dynamic imports across features",
    "features/tasks/example.ts",
    'void import("~/features/runs/example");',
    "web-import-direction",
  ],
  [
    "parent-relative imports",
    "features/tasks/example.ts",
    'import "../../lib/example";',
    "web-import-direction",
  ],
  [
    "child-relative imports",
    "features/tasks/example.ts",
    'import "./components/example";',
    "web-import-direction",
  ],
  ["the old alias", "features/tasks/example.ts", 'import "@/lib/example";', "web-import-direction"],
  ["default exports", "features/tasks/example.ts", "export default 1;", "no-default-export"],
]) {
  test(`rejects ${name}`, () => {
    const result = lint(`apps/web/src/${filename}`, source);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, new RegExp(rule));
  });
}

for (const [filename, source] of [
  ["routes/example.ts", 'import "~/features/tasks/example";'],
  ["features/tasks/example.ts", 'import "~/features/tasks/components/example";'],
  [
    "features/tasks/example.ts",
    'import "~/components/example"; import "~/hooks/example"; import "~/lib/example";',
  ],
  ["lib/example.ts", 'import "./sibling";'],
  ["components/ui/example.ts", "export default 1;"],
]) {
  test(`allows ${source} in ${filename}`, () => {
    const result = lint(`apps/web/src/${filename}`, source);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
