// Takes a checkpoint of a probe machine, changes the machine, restores the checkpoint in place,
// and times each step. Run it on a machine started from a template with the loops of fork.mjs.
// Usage: node checkpoint.mjs <machine name> <runs>
import { assertMine, client, firstExec, leakCommand, logger, now, PREFIX, scrub, sh, sleep, stats } from "./lib.mjs";

const [machine, runsArg] = process.argv.slice(2);
assertMine(machine);
const boxd = client();
const log = logger();
const name = `${PREFIX}clean`;
const IMAGE = "ghcr.io/basaltbytes/usine-worker:claude-2.1.311-codex-0.164.0";

try {
  let t0 = now();
  await boxd.machines.checkpoints.create(machine, name);
  const callMs = Math.round(now() - t0);
  let cp;
  for (;;) {
    cp = (await boxd.machines.checkpoints.list(machine)).find((c) => c.name === name);
    if (cp?.status === "ready") break;
    if (cp?.status === "failed") throw new Error("checkpoint failed");
    await sleep(250);
  }
  log("checkpoint", { callMs, readyMs: Math.round(now() - t0), sizeBytes: cp.sizeBytes, available: cp.available });
  const gap = await sh(boxd, machine, `awk 'NR > 1 && $1 - p > 200 { print p, $1 - p } { p = $1 }' /home/boxd/tick | tail -n 1`);
  log("pause-during-checkpoint", { lastGap: gap });

  const restores = [];
  for (let i = 0; i < Number(runsArg); i++) {
    await sh(boxd, machine, `echo dirty > /home/boxd/dirty-${i} && docker run -d --name probe-${i} ${IMAGE} sleep 9999 >/dev/null`);
    const startEpoch = Date.now();
    t0 = now();
    await boxd.machines.checkpoints.restore(machine, name);
    const restoreMs = Math.round(now() - t0);
    const first = await firstExec(boxd, machine, t0);
    const state = await sh(boxd, machine, `ls /home/boxd | tr '\\n' ' '; echo; docker ps -aq | wc -l; echo; tail -n 1 /home/boxd/tick; date +%s%3N`);
    const leaks = await sh(boxd, machine, leakCommand(startEpoch));
    const m = await boxd.machines.get(machine);
    restores.push({ restoreMs, firstExecMs: first.ms });
    log("restore", { i, restoreMs, firstExecMs: first.ms, state: state.split("\n"), leaks, egressAllow: m.egressAllow, status: m.status });
  }
  log("stats", { restoreMs: stats(restores.map((r) => r.restoreMs)), firstExecMs: stats(restores.map((r) => r.firstExecMs)) });
} catch (e) {
  console.error(scrub(`${e?.constructor?.name}: ${e?.message}`));
  process.exitCode = 1;
} finally {
  await boxd.machines.checkpoints.delete(machine, name).then(
    () => log("deleted-checkpoint", { name }),
    (e) => log("checkpoint-delete-failed", { error: scrub(e.message) }),
  );
}
