// Tests replace only Linux process identity; process execution and journals remain real.
// @effect-diagnostics nodeBuiltinImport:off
import { spawnSync } from "node:child_process";
import { run as runOwner } from "../../src/child-host/worker/owner.ts";

import type { WorkerSources } from "../../src/child-host/worker/program.ts";

export const run = (sources: WorkerSources) =>
  runOwner(sources, (pid) => {
    const status = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
    if (status.error !== undefined) throw status.error;
    if (status.status !== 0 || status.stdout.trim().startsWith("Z")) return null;
    return `test-boot:${pid}`;
  });
