// Restores one machine from a snapshot and times it to the first successful exec.
// Usage: node restore.mjs <suffix> <driver|spec> [snapshot] [identity] [keep]
//   driver: create with isolated and labels, then SetVmEgressAllow, both idle timers off, and a
//           one-second wait, as the boxd driver does.
//   spec:   create with a machine spec that carries isolated, labels, and the egress allowlist,
//           then both idle timers off, with no wait.
// Then checks egress from the first command: a blocked host and an admitted one.
import { assertMine, client, firstExec, identity, leakCommand, logger, now, PREFIX, remove, scrub, sleep } from "./lib.mjs";

const [suffix, mode, snapshotArg, ...flags] = process.argv.slice(2);
const name = `${PREFIX}${suffix}`;
assertMine(name);
const source = snapshotArg && snapshotArg !== "-" ? snapshotArg : "usine-attempt";
const EGRESS = ["*.tailscale.com", "registry.npmjs.org"];
const boxd = client();
const log = logger();

const egressCheck = async (id) => {
  const probe = async (url) => {
    const r = await boxd.machines.exec(id, {
      command: `curl -sS -m 4 -o /dev/null -w '%{http_code}' ${url} 2>&1 || true`,
      timeout: 15_000,
    });
    return r.stdout.trim().slice(0, 80);
  };
  return { blocked: await probe("https://example.com"), admitted: await probe("https://registry.npmjs.org/") };
};

let id;
try {
  const startEpoch = Date.now();
  log.t0 = now();
  const labels = { "usine.probe": "1103" };
  const machine =
    mode === "spec"
      ? await boxd.machines.create({
          fromSnapshot: source,
          name,
          spec: { version: 1, isolated: true, labels, egress: EGRESS },
          deleteAfter: 1800,
        })
      : await boxd.machines.create({ fromSnapshot: source, name, isolated: true, labels, deleteAfter: 1800 });
  id = machine.id;
  const createdMs = Math.round(now() - log.t0);
  log("created", { id, status: machine.status, egressAllow: machine.egressAllow, idle: machine.idle, source: machine.source });
  const exec = firstExec(boxd, id, log.t0);
  if (mode === "spec") {
    await Promise.all([boxd.machines.setAutoHibernateTimeout(id, 0), boxd.machines.setAutoSuspendTimeout(id, 0)]);
  } else {
    await boxd.machines.setEgressAllow(id, EGRESS);
    await boxd.machines.setAutoHibernateTimeout(id, 0);
    await boxd.machines.setAutoSuspendTimeout(id, 0);
    await sleep(1000);
  }
  const readyMs = Math.round(now() - log.t0);
  const first = await exec;
  const egress = await egressCheck(id);
  const leaks = (await boxd.machines.exec(id, { command: leakCommand(startEpoch) })).stdout.trim();
  log("result", { mode, source, createdMs, firstExecMs: first.ms, tries: first.tries, readyMs, egress, leaks });
  if (flags.includes("identity")) log("identity", await identity(boxd, id));
  const after = await boxd.machines.get(id);
  log("record", { status: after.status, egressAllow: after.egressAllow, idle: after.idle, labels: after.labels, ssh: after.ssh, spec: after.spec ? { egress: after.spec.egress, isolated: after.spec.isolated } : null, bootTimeMs: after.bootTimeMs });
  if (flags.includes("keep")) {
    log("kept", { id });
    id = undefined;
  }
} catch (e) {
  console.error(scrub(`${e?.constructor?.name}: ${e?.message}`));
  process.exitCode = 1;
} finally {
  if (id) {
    await remove(boxd, id);
    log("deleted");
  }
}
