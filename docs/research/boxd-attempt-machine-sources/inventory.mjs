// Prints the machine limit, the source snapshot, and every machine, snapshot, disk, and
// checkpoint named probe-1103-*. With `delete`, deletes those probe resources.
// Usage: node inventory.mjs [delete]
import { assertMine, client, logger, PREFIX, scrub } from "./lib.mjs";

const boxd = client();
const log = logger();
const purge = process.argv[2] === "delete";
const mine = (name) => String(name).startsWith(PREFIX);

try {
  const limit = await boxd.orgs.getMachineLimit();
  log("limit", { maxVms: limit.maxVms, vmCount: limit.vmCount });
  const source = await boxd.snapshots.get("usine-attempt");
  log("source-snapshot", {
    status: source.status,
    version: source.version,
    sizeBytes: source.sizeBytes,
    vcpu: source.vcpu,
    memoryBytes: source.memoryBytes,
    storage: source.storage,
    region: source.region,
    useCount: source.useCount,
  });
  const machines = await boxd.machines.list();
  log("machines", {
    total: machines.length,
    byStatus: machines.reduce((acc, m) => ({ ...acc, [m.status]: (acc[m.status] ?? 0) + 1 }), {}),
    probes: machines.filter((m) => mine(m.name)).map((m) => ({ id: m.id, name: m.name, status: m.status })),
  });
  for (const m of machines.filter((m) => mine(m.name))) {
    const checkpoints = await boxd.machines.checkpoints.list(m.id);
    log("checkpoints", { machine: m.name, names: checkpoints.map((c) => c.name) });
    if (purge) {
      for (const c of checkpoints) {
        assertMine(c.name);
        await boxd.machines.checkpoints.delete(m.id, c.name);
        log("deleted-checkpoint", { machine: m.name, name: c.name });
      }
      assertMine(m.name);
      await boxd.machines.delete(m.id);
      log("deleted-machine", { name: m.name });
    }
  }
  const snapshots = await boxd.snapshots.list();
  const snapList = Array.isArray(snapshots) ? snapshots : (snapshots.items ?? []);
  log("snapshots", { total: snapList.length, probes: snapList.filter((s) => mine(s.name)).map((s) => s.name) });
  const disks = await boxd.disks.list();
  const diskList = Array.isArray(disks) ? disks : (disks.items ?? []);
  log("disks", { total: diskList.length, probes: diskList.filter((d) => mine(d.name)).map((d) => ({ name: d.name, attachments: d.attachments })) });
  if (purge) {
    for (const s of snapList.filter((s) => mine(s.name))) {
      assertMine(s.name);
      await boxd.snapshots.delete(s.name);
      log("deleted-snapshot", { name: s.name });
    }
    for (const d of diskList.filter((d) => mine(d.name))) {
      assertMine(d.name);
      await boxd.disks.delete(d.id);
      log("deleted-disk", { name: d.name });
    }
  }
} catch (e) {
  console.error(scrub(`${e?.constructor?.name}: ${e?.message}`));
  process.exitCode = 1;
}
