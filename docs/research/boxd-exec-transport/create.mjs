// Creates one probe machine from the usine-attempt snapshot and times create -> first exec.
// Usage: node create.mjs <suffix> [keep]
import { scrub, assertMine, client, now, PREFIX } from "./lib.mjs";

const name = `${PREFIX}${process.argv[2]}`;
assertMine(name);
const keep = process.argv[3] === "keep";
const boxd = client();
const log = (event, fields = {}) => console.log(JSON.stringify({ t: Math.round(now() - t0), event, ...fields }));
let t0 = now();
try {
  const regions = await boxd.regions.list();
  log("regions", { regions: regions.map((r) => ({ id: r.id, endpoint: r.apiEndpoint ?? r.endpoint, home: r.home })) });
  t0 = now();
  const machine = await boxd.machines.create({
    fromSnapshot: "usine-attempt",
    name,
    isolated: true,
    labels: { "usine.probe": "1106" },
    deleteAfter: 7200,
  });
  log("created", { id: machine.id, status: machine.status, publicIp: machine.publicIp, sshPort: machine.sshPort });
  await boxd.machines.setAutoHibernateTimeout(machine.id, 0);
  await boxd.machines.setAutoSuspendTimeout(machine.id, 0);
  log("timers-off");
  let attempts = 0;
  let lastError = "";
  while (now() - t0 < 180_000) {
    attempts++;
    const ta = now();
    try {
      const r = await boxd.machines.exec(machine.id, { command: ["true"], timeout: 10_000 });
      log("first-exec", { attempts, exitCode: r.exitCode, callMs: Math.round(now() - ta) });
      break;
    } catch (e) {
      const m = `${e?.constructor?.name}: ${scrub(e?.message)}`;
      if (m !== lastError) log("exec-error", { attempts, error: m });
      lastError = m;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const after = await boxd.machines.get(machine.id);
  log("status", { status: after.status });
  if (!keep) {
    assertMine(after.name);
    await boxd.machines.delete(machine.id);
    log("deleted");
  }
} catch (e) {
  console.error(scrub(`${e?.constructor?.name}: ${e?.message}`));
  process.exitCode = 1;
}
