import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const readYaml = (path) => parse(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"));

test("the lockfile resolves one @types/node, at the catalog version", () => {
  const { catalog } = readYaml("pnpm-workspace.yaml");
  const { packages } = readYaml("pnpm-lock.yaml");
  assert.deepEqual(
    Object.keys(packages).filter((key) => key.startsWith("@types/node@")),
    [`@types/node@${catalog["@types/node"]}`],
    "packages that don't declare @types/node load the hoisted copy, so a second version can break the build after an incremental install",
  );
});
