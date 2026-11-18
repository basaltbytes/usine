import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Lints `source` as `filename` under `apps/web/src`, in a probe folder next to it that keeps the
 * file's name, and returns the oxlint process result.
 */
export const lint = (filename, source) => {
  const folder = join(root, "apps/web/src", dirname(filename), `oxlint-probe-${process.pid}`);
  mkdirSync(folder);
  const probe = join(folder, basename(filename));
  writeFileSync(probe, source);
  try {
    return spawnSync("corepack", ["pnpm", "exec", "oxlint", probe], {
      cwd: root,
      encoding: "utf8",
    });
  } finally {
    rmSync(folder, { recursive: true });
  }
};
