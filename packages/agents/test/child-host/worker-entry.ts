// Tests replace only Linux process identity; process execution and journals remain real.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics processEnv:off
// @effect-diagnostics globalDate:off
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { run as runOwner } from "../../src/child-host/worker/owner.ts";

import type { WorkerSources } from "../../src/child-host/worker/program.ts";

/** Blocks until the lifeline has started the harness and recorded its PID, for at most 5 seconds. */
const awaitLifeline = (pidFile: string) => {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 5000;
  while (!existsSync(`${pidFile}.transport/process`) && Date.now() < deadline)
    Atomics.wait(pause, 0, 0, 10);
};

export const run = (sources: WorkerSources) =>
  runOwner(sources, (pid) => {
    if (
      process.env.WORKER_TEST_LIFELINE_IDENTITY === "missing" &&
      process.argv[1] === "supervise" &&
      pid !== process.pid
    ) {
      awaitLifeline(process.argv[2] ?? "");
      return null;
    }
    const status = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
    if (status.error !== undefined) throw status.error;
    if (status.status !== 0 || status.stdout.trim().startsWith("Z")) return null;
    return `test-boot:${pid}`;
  });
