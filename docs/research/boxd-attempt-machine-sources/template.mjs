// Lifecycle of a probe template machine, each step timed.
// Usage:
//   node template.mjs create <suffix> [snapshot]  restore an isolated machine, idle timers off
//   node template.mjs sh <name> <command>         run a command and print its output
//   node template.mjs egress <name> <entries...>  replace the egress allowlist ("-" clears it)
//   node template.mjs hibernate <name>            hibernate and wait for the status
//   node template.mjs wake <name>                 wake and time to the first exec
//   node template.mjs status <name>               print the machine record and the machine limit
//   node template.mjs snapshot <name> <snapshot>  save a snapshot and time it to ready
//   node template.mjs delete <name>               delete the machine
import { assertMine, client, firstExec, logger, now, PREFIX, scrub, sleep } from "./lib.mjs";

const [action, target, ...rest] = process.argv.slice(2);
const boxd = client();
const log = logger();

const record = (m) => ({
  id: m.id,
  name: m.name,
  status: m.status,
  egressAllow: m.egressAllow,
  idle: m.idle,
  labels: m.labels,
  source: m.source,
  hibernatedAt: m.hibernatedAt,
  bootTimeMs: m.bootTimeMs,
  resources: m.resources,
  ssh: m.ssh,
});

const waitStatus = async (name, wanted, limitMs = 300_000) => {
  const t0 = now();
  for (;;) {
    const m = await boxd.machines.get(name);
    if (m.status === wanted) return Math.round(now() - t0);
    if (now() - t0 > limitMs) throw new Error(`still ${m.status} after ${limitMs} ms`);
    await sleep(250);
  }
};

try {
  if (action === "create") {
    const name = `${PREFIX}${target}`;
    assertMine(name);
    const machine = await boxd.machines.create({
      fromSnapshot: rest[0] ?? "usine-attempt",
      name,
      isolated: true,
      labels: { "usine.probe": "1103", "usine.role": "template" },
      deleteAfter: 5400,
    });
    await boxd.machines.setAutoHibernateTimeout(machine.id, 0);
    await boxd.machines.setAutoSuspendTimeout(machine.id, 0);
    const first = await firstExec(boxd, machine.id, log.t0);
    log("created", { ...record(machine), firstExecMs: first.ms });
  } else {
    assertMine(target);
    if (action === "sh") {
      const t0 = now();
      const r = await boxd.machines.exec(target, { command: rest.join(" "), timeout: 1_800_000 });
      log("sh", { exitCode: r.exitCode, ms: Math.round(now() - t0) });
      process.stdout.write(scrub(r.stdout));
      if (r.stderr) process.stderr.write(scrub(r.stderr));
      process.exitCode = r.exitCode;
    } else if (action === "egress") {
      const entries = rest[0] === "-" ? [] : rest;
      log("egress", { inEffect: await boxd.machines.setEgressAllow(target, entries) });
    } else if (action === "hibernate") {
      const t0 = now();
      await boxd.machines.hibernate(target);
      const callMs = Math.round(now() - t0);
      const statusMs = await waitStatus(target, "hibernated");
      const limit = await boxd.orgs.getMachineLimit();
      log("hibernated", { callMs, statusMs, vmCount: limit.vmCount });
    } else if (action === "wake") {
      const t0 = now();
      await boxd.machines.wake(target);
      const callMs = Math.round(now() - t0);
      const first = await firstExec(boxd, target, t0);
      log("woken", { callMs, firstExecMs: first.ms });
    } else if (action === "status") {
      const m = await boxd.machines.get(target);
      const limit = await boxd.orgs.getMachineLimit();
      const all = await boxd.machines.list();
      log("status", { ...record(m), vmCount: limit.vmCount, listed: all.map((x) => x.status) });
    } else if (action === "snapshot") {
      const snapshot = rest[0];
      assertMine(snapshot);
      const previous = await boxd.snapshots.get(snapshot).then(
        (s) => s.version ?? 0,
        () => 0,
      );
      const t0 = now();
      const created = await boxd.snapshots.create(target, snapshot);
      const callMs = Math.round(now() - t0);
      let s;
      for (;;) {
        s = await boxd.snapshots.get(snapshot);
        if (s.status === "ready" && (s.version ?? 0) > previous) break;
        if (s.status === "failed") throw new Error("snapshot failed");
        if (now() - t0 > 600_000) throw new Error(`snapshot still ${s.status}`);
        await sleep(250);
      }
      log("snapshot", { callMs, readyMs: Math.round(now() - t0), createdStatus: created.status, version: s.version, sizeBytes: s.sizeBytes, storage: s.storage, vcpu: s.vcpu, memoryBytes: s.memoryBytes });
      log("source-after", record(await boxd.machines.get(target)));
    } else if (action === "delete") {
      await boxd.machines.delete(target);
      log("deleted", { name: target });
    } else {
      throw new Error(`unknown action ${action}`);
    }
  }
} catch (e) {
  console.error(scrub(`${e?.constructor?.name}: ${e?.message}`));
  process.exitCode = 1;
}
