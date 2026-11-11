// Prints the org's metered rates and the usage of every probe-1103- machine since a start time.
// Usage: node cost.mjs <ISO start time>
import { client, logger, PREFIX, scrub } from "./lib.mjs";

const boxd = client();
const log = logger();
const since = new Date(process.argv[2] ?? Date.now() - 24 * 3600_000);

try {
  const usage = await boxd.orgs.usage({ since });
  log("rates", { currency: usage.currency, rates: usage.rates, period: usage.period });
  const probes = usage.machines.filter((m) => m.name.startsWith(PREFIX));
  for (const m of probes)
    log("machine", {
      name: m.name,
      status: m.status,
      seconds: m.seconds,
      vcpuHours: m.vcpuHours,
      ramGibHours: m.ramGibHours,
      diskGibHours: m.diskGibHours,
      cost: m.costMicro / 1e6,
      complete: m.complete,
    });
  log("total", {
    probes: probes.length,
    cost: probes.reduce((s, m) => s + m.costMicro, 0) / 1e6,
    complete: probes.every((m) => m.complete),
  });
  const others = usage.machines.filter((m) => !m.name.startsWith(PREFIX) && m.status === "hibernated");
  for (const m of others)
    log("hibernated-reference", {
      seconds: m.seconds,
      diskGibHours: m.diskGibHours,
      ramGibHours: m.ramGibHours,
      resources: m.resources,
      cost: m.costMicro / 1e6,
    });
} catch (e) {
  console.error(scrub(`${e?.constructor?.name}: ${e?.message}`));
  process.exitCode = 1;
}
