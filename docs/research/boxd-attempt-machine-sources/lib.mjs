// Shared helpers for the probes in docs/research/boxd-attempt-machine-sources.md.
//
// Set BOXD_SDK_DIR to a directory where `npm install --ignore-scripts @boxd-sh/sdk@0.3.0` ran, and
// either BOXD_API_KEY or BOXD_ENV_FILE, a dotenv file with a BOXD_API_KEY line. The probes create,
// change, and delete only machines, snapshots, disks, and checkpoints whose names start with
// probe-1103-, and never print the key.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const sdkDir = process.env.BOXD_SDK_DIR;
if (!sdkDir) throw new Error("Set BOXD_SDK_DIR");
const modules = (path) => pathToFileURL(`${sdkDir}/node_modules/${path}`).href;

export const sdk = await import(modules("@boxd-sh/sdk/dist/index.js"));

const keyFromFile = () => {
  const file = process.env.BOXD_ENV_FILE;
  if (!file) return undefined;
  const line = readFileSync(file, "utf8")
    .split("\n")
    .find((l) => l.startsWith("BOXD_API_KEY="));
  return line?.slice("BOXD_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
};

const key = process.env.BOXD_API_KEY || keyFromFile();
export const apiKey = () => {
  if (!key) throw new Error("Set BOXD_API_KEY or BOXD_ENV_FILE");
  return key;
};

export const scrub = (text) => String(text).replaceAll(apiKey(), "[redacted]");

export const PREFIX = "probe-1103-";

export const assertMine = (name) => {
  if (!String(name).startsWith(PREFIX)) throw new Error(`refusing to touch ${name}`);
};

export const client = (opts = {}) => new sdk.Boxd({ apiKey: apiKey(), region: "fra", ...opts });

export const now = () => performance.now();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    n: sorted.length,
    median: Math.round(median),
    min: Math.round(sorted[0]),
    max: Math.round(sorted.at(-1)),
  };
};

export const logger = (t0 = now()) => {
  const log = (event, fields = {}) =>
    console.log(scrub(JSON.stringify({ t: Math.round(now() - log.t0), event, ...fields })));
  log.t0 = t0;
  return log;
};

/** Runs `command` on a machine and returns its trimmed stdout, or throws with stderr. */
export const sh = async (boxd, id, command, timeout = 120_000) => {
  const r = await boxd.machines.exec(id, { command, timeout });
  if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout.trim();
};

/** Polls `exec true` every 100 ms from `t0` until it succeeds; returns the elapsed ms and tries. */
export const firstExec = async (boxd, id, t0, limitMs = 180_000) => {
  let tries = 0;
  let lastError = "";
  while (now() - t0 < limitMs) {
    tries++;
    try {
      const r = await boxd.machines.exec(id, { command: ["true"], timeout: 10_000 });
      if (r.exitCode === 0) return { ms: Math.round(now() - t0), tries, lastError };
    } catch (e) {
      lastError = scrub(`${e?.constructor?.name}: ${e?.message}`);
    }
    await sleep(100);
  }
  throw new Error(`no exec within ${limitMs} ms: ${lastError}`);
};

/**
 * A command that prints what the template's egress loop logged after `startEpoch` (ms) and the
 * allowlist didn't stop: `+<ms after start>:<HTTP code>:<dns-ok|dns-no>` for each attempt that got
 * an HTTP answer from example.com or resolved its name. Each line of /home/boxd/egress-log is
 * `<epoch ms> <HTTP code or 000> <dns-ok|dns-no>`, written every 100 ms by a loop started with
 * setsid on the template; `fork.mjs` documents it.
 */
export const leakCommand = (startEpoch) =>
  `test -f /home/boxd/egress-log && awk -v t=${startEpoch} '$1 > t && ($2 != "000" || $3 == "dns-ok") { printf "+%d:%s:%s ", $1 - t, $2, $3 } $1 > t { n++ } END { printf "(%d attempts after start)", n }' /home/boxd/egress-log || echo no-loop`;

/** Deletes a probe machine by id after checking its name. */
export const remove = async (boxd, id) => {
  const m = await boxd.machines.get(id);
  assertMine(m.name);
  await boxd.machines.delete(id);
};

/**
 * What a machine says about itself: identity, processes, clocks, and the first bytes of its
 * random pool. Every field is one line of shell output.
 */
export const IDENTITY = {
  hostname: "hostname",
  machineId: "cat /etc/machine-id",
  bootId: "cat /proc/sys/kernel/random/boot_id",
  uptime: "cut -d' ' -f1 /proc/uptime",
  epochMs: "date +%s%3N",
  urandom: "head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \\n'",
  sshHostKeys: "cat /etc/ssh/ssh_host_*_key.pub 2>/dev/null | sha256sum | cut -c1-16",
  boxdIp: "echo $boxd_ip",
  boxdVmId: "echo $BOXD_VM_ID",
  dockerd: "pgrep -x dockerd >/dev/null && echo running || echo stopped",
  dockerEngineId: "sudo cat /var/lib/docker/engine-id 2>/dev/null || echo none",
  tailscaled: "systemctl is-active tailscaled || true",
  tailscaleState: "sudo test -s /var/lib/tailscale/tailscaled.state && sudo sha256sum /var/lib/tailscale/tailscaled.state | cut -c1-16 || echo none",
  vmgenid: "ls /sys/bus/acpi/devices 2>/dev/null | grep -i -c vmgen || true",
  dmesgRandom: "sudo dmesg 2>/dev/null | grep -i 'vmgenid\\|crng\\|random' | tail -n 4 | cut -c1-120 | tr '\\n' '|' || true",
  kernel: "uname -r",
};

export const identity = async (boxd, id) => {
  const before = Date.now();
  const remote = Number(await sh(boxd, id, "date +%s%3N", 20_000));
  const after = Date.now();
  const out = { clockSkewMs: remote - Math.round((before + after) / 2), clockRttMs: after - before };
  for (const [k, cmd] of Object.entries(IDENTITY)) {
    try {
      out[k] = await sh(boxd, id, cmd, 20_000);
    } catch (e) {
      out[k] = `error: ${scrub(e.message).slice(0, 120)}`;
    }
  }
  return out;
};
