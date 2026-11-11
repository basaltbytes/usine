// Creates a probe disk, attaches it to one machine, tries a second attachment, then moves it to a
// new machine restored with the disk in `config.volumes`. Deletes the disk and the new machine.
// Usage: node disk.mjs <machine name> <suffix for the new machine>
import { assertMine, client, firstExec, logger, now, PREFIX, remove, scrub, sh, sleep } from "./lib.mjs";

const [machine, suffix] = process.argv.slice(2);
assertMine(machine);
const second = `${PREFIX}${suffix}`;
assertMine(second);
const boxd = client();
const log = logger();
const diskName = `${PREFIX}disk`;
let disk;
let secondId;

const timed = async (label, fn) => {
  const t0 = now();
  try {
    const value = await fn();
    log(label, { ms: Math.round(now() - t0), ok: true, value });
    return value;
  } catch (e) {
    log(label, { ms: Math.round(now() - t0), ok: false, error: scrub(`${e?.constructor?.name}: ${e?.message}`) });
    return undefined;
  }
};

try {
  disk = await timed("create", () => boxd.disks.create(diskName, "1G"));
  for (;;) {
    const d = (await boxd.disks.list()).find((x) => x.id === disk.id);
    if (d?.status === "ready") break;
    await sleep(250);
  }
  await timed("attach", () => boxd.disks.attach(disk.id, machine, "/mnt/probe"));
  await timed("write", () => sh(boxd, machine, "mount | grep /mnt/probe; sudo sh -c 'echo cached > /mnt/probe/marker' && sync && cat /mnt/probe/marker"));
  const t0 = now();
  const created = await boxd.machines.create({ fromSnapshot: "usine-attempt", name: second, isolated: true, labels: { "usine.probe": "1103" }, deleteAfter: 1800 });
  secondId = created.id;
  log("second-machine", { ms: (await firstExec(boxd, secondId, t0)).ms });
  await timed("attach-second-read-only", () => boxd.disks.attach(disk.id, second, "/mnt/probe", { readOnly: true }));
  await timed("detach", () => boxd.disks.detach(disk.id, machine));
  await timed("attach-second-after-detach", () => boxd.disks.attach(disk.id, second, "/mnt/probe", { readOnly: true }));
  await timed("read-second", () => sh(boxd, second, "cat /mnt/probe/marker"));
  await timed("detach-second", () => boxd.disks.detach(disk.id, second));
  await timed("restore-with-volume", async () => {
    const t1 = now();
    const m = await boxd.machines.create({
      fromSnapshot: "usine-attempt",
      name: `${second}-v`,
      isolated: true,
      labels: { "usine.probe": "1103" },
      deleteAfter: 1800,
      config: { volumes: [{ diskId: disk.id, mountPath: "/mnt/probe", readOnly: true }] },
    });
    const first = await firstExec(boxd, m.id, t1);
    const marker = await sh(boxd, m.id, "cat /mnt/probe/marker 2>&1 || true");
    await remove(boxd, m.id);
    return { firstExecMs: first.ms, marker };
  });
} catch (e) {
  console.error(scrub(`${e?.constructor?.name}: ${e?.message}`));
  process.exitCode = 1;
} finally {
  if (secondId) {
    await remove(boxd, secondId);
    log("deleted-machine", { name: second });
  }
  if (disk) {
    await sleep(2000);
    await timed("delete-disk", () => boxd.disks.delete(disk.id));
  }
}
