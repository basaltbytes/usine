#!/usr/bin/env node
// Builds a boxd snapshot with the container runtime, the attempt image, and empty Tailscale state,
// through boxd's API with BOXD_API_KEY alone. The tests in test/ cover the API calls with a fake;
// a real build is the acceptance test.
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { Boxd, Machine } from "@boxd-sh/sdk";
import { boxdEgress } from "./egress.mjs";

const USAGE =
  "Usage: build-snapshot.mjs [--size <vcpu>x<GiB>] [--region <id>] [--endpoint <url>] <snapshot-name>";
/** The pattern of `BoxdSize` in `@usine/core/worker`, so `provisioner.size` can name the size. */
const SIZE = /^[1-9][0-9]{0,3}x[1-9][0-9]{0,5}$/u;
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const REGION = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const IMAGE = /^[A-Za-z0-9./:@_-]+$/u;
const READY_TIMEOUT_MS = 180_000;
const SNAPSHOT_TIMEOUT_MS = 600_000;
const POLL_MS = 1_000;
const EGRESS_TIMEOUT_MS = 30_000;
/**
 * How long after boxd reports an egress edit the edit may still be on its way to the machine. The
 * SDK documents that an edit takes effect within a second, and the boxd provisioner waits as long.
 */
const EGRESS_IN_FORCE_MS = 1_000;

/**
 * The most stdin bytes in one `Exec` message. boxd closes the command's stdin without an error at
 * 4 MiB or more (docs/research/boxd-exec-transport.md).
 */
export const STDIN_CHUNK_BYTES = 64 * 1024;

/** The error for arguments or environment variables that the script refuses. */
export class UsageError extends Error {}

/**
 * Runs in the builder as user `boxd`, with the runtime and the image as `$1` and `$2`, and leaves
 * the state that every restore resumes.
 */
const SETUP = `set -eu
runtime=$1
image=$2
sudo install -d -m 0755 /etc/usine
printf '%s\\n' "$runtime" | sudo tee /etc/usine/container-runtime >/dev/null
install -d -m 0700 /home/boxd/.usine /home/boxd/.cache/turbo
if [ "$runtime" = podman ]; then
  sudo apt-get update
  sudo apt-get install -y podman crun uidmap dbus-user-session slirp4netns fuse-overlayfs
  sudo loginctl enable-linger boxd
  sudo systemctl start "user@$(id -u).service"
  export XDG_RUNTIME_DIR=/run/user/$(id -u)
fi
"$runtime" pull "$image"
"$runtime" volume create usine-pnpm-store >/dev/null
"$runtime" volume create usine-turbo-cache >/dev/null
curl -fsSL https://tailscale.com/install.sh -o /tmp/usine-tailscale.sh
sudo sh /tmp/usine-tailscale.sh
rm /tmp/usine-tailscale.sh
sudo systemctl enable tailscaled
sudo systemctl stop tailscaled
sudo rm -f /var/lib/tailscale/tailscaled.state
sync
`;

/**
 * Parses the command line and the environment. Throws `UsageError` for a missing API key, an
 * unknown option, or an invalid size, region, endpoint, snapshot name, runtime, or image.
 */
export const parseOptions = (argv, env) => {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        size: { type: "string", default: "2x8" },
        region: { type: "string" },
        endpoint: { type: "string" },
      },
    });
  } catch (error) {
    throw new UsageError(error.message);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) throw new UsageError("Pass one snapshot name");
  const [snapshot] = positionals;
  if (!NAME.test(snapshot))
    throw new UsageError(`Invalid snapshot name ${JSON.stringify(snapshot)}`);
  if (!SIZE.test(values.size))
    throw new UsageError(
      `Invalid size ${JSON.stringify(values.size)}: pass <vcpu>x<GiB>, such as 2x8`,
    );
  if (values.region !== undefined && !REGION.test(values.region))
    throw new UsageError(`Invalid region ${JSON.stringify(values.region)}`);
  if (values.endpoint !== undefined && values.endpoint.trim() === "")
    throw new UsageError("Invalid endpoint: pass the cluster's API endpoint URL");
  const apiKey = env.BOXD_API_KEY ?? "";
  if (apiKey === "") throw new UsageError("Set BOXD_API_KEY to a boxd API key");
  const runtime = env.USINE_CONTAINER_RUNTIME ?? "docker";
  if (runtime !== "docker" && runtime !== "podman")
    throw new UsageError("Invalid USINE_CONTAINER_RUNTIME: use docker or podman");
  const tag = () =>
    readFileSync(new URL("../worker-image/tag.txt", import.meta.url), "utf8").trim();
  const image = env.ATTEMPT_IMAGE ?? `ghcr.io/basaltbytes/usine-worker:${tag()}`;
  if (!IMAGE.test(image)) throw new UsageError("Invalid ATTEMPT_IMAGE");
  return {
    snapshot,
    size: values.size,
    region: values.region,
    endpoint: values.endpoint,
    apiKey,
    runtime,
    image,
  };
};

/**
 * Returns the options of the boxd client: the hosted endpoint unless `endpoint` is set, and the
 * region that `endpoint` serves unless `region` is set.
 */
export const clientOptions = ({ apiKey, endpoint, region }) => {
  const options = { apiKey };
  if (endpoint !== undefined) options.baseURL = endpoint;
  if (region !== undefined) options.region = region;
  return options;
};

/** Writes `bytes` to the stdin of `stream` in chunks of at most `STDIN_CHUNK_BYTES`, then closes it. */
export const sendStdin = (stream, bytes) => {
  for (let start = 0; start < bytes.length; start += STDIN_CHUNK_BYTES)
    stream.write(bytes.subarray(start, start + STDIN_CHUNK_BYTES));
  stream.end();
};

const sameEntries = (left, right) =>
  JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());

const throwIfAborted = (signal) => {
  if (signal.aborted) throw new Error("Interrupted");
};

const describeEgress = (entries) => (entries.length === 0 ? "unrestricted" : entries.join(", "));

/**
 * Reads `machine` until boxd reports `entries` as its egress allowlist in effect, polling every
 * `pollMs` for at most `timeoutMs`, and returns the last read.
 */
const waitForEgress = async (boxd, machine, entries, { signal, pollMs, timeoutMs }) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    throwIfAborted(signal);
    const read = await boxd.machines.get(machine);
    if (sameEntries(read.egressAllow, entries)) return read;
    if (Date.now() > deadline)
      throw new Error(
        `boxd didn't report the temporary machine's egress as ${describeEgress(entries)} within ${timeoutMs / 1000} seconds`,
      );
    await sleep(pollMs);
  }
};

/** Runs the setup on `machine` and relays its output to `output`. Returns the exit code. */
const runSetup = async (boxd, machine, { runtime, image }, { output, signal }) => {
  const stream = boxd.machines.streamExec(machine, {
    command: `sh -s -- '${runtime}' '${image}'`,
  });
  const close = () => stream.close();
  signal.addEventListener("abort", close, { once: true });
  try {
    sendStdin(stream, new TextEncoder().encode(SETUP));
    const relay = async (chunks) => {
      for await (const chunk of chunks) output.write(chunk);
    };
    const [code] = await Promise.all([stream.wait(), relay(stream.stdout), relay(stream.stderr)]);
    return code;
  } finally {
    signal.removeEventListener("abort", close);
  }
};

/**
 * Saves `machine` as snapshot `name` and waits until boxd reports the version that the save
 * captures ready, polling every `pollMs` for at most `timeoutMs`. A snapshot's `version` is its
 * latest ready one, and its status is `failed` only while it has no ready version, so a failed
 * save of a snapshot that has one only shows as the deadline. A `failed` read counts as the save's
 * failure only after a read showed the save `pending`; an earlier one can be the record of a
 * previous save.
 */
const saveSnapshot = async (boxd, machine, name, { signal, pollMs, timeoutMs }) => {
  const { version } = await boxd.snapshots.create(machine, name);
  const deadline = Date.now() + timeoutMs;
  let started = false;
  for (;;) {
    throwIfAborted(signal);
    const snapshot = await boxd.snapshots.get(name);
    if (snapshot.status === "ready" && (snapshot.version ?? 0) >= version) return snapshot;
    if (snapshot.status === "pending") started = true;
    else if (snapshot.status === "failed" && started)
      throw new Error(`boxd reports that version ${version} of snapshot ${name} failed`);
    if (Date.now() > deadline)
      throw new Error(
        `Version ${version} of snapshot ${name} didn't become ready within ${timeoutMs / 1000} seconds`,
      );
    await sleep(pollMs);
  }
};

/**
 * Builds snapshot `options.snapshot` on a temporary machine and returns its name. The machine is
 * shared with the API key's org, isolated, at `options.size`, with the egress allowlist of
 * `egress.mjs` in its spec, which the snapshot keeps. The setup runs with egress unrestricted,
 * because it downloads from hosts outside the allowlist. The machine is deleted when the build
 * ends, fails, or `signal` aborts; `log` names it if its deletion fails. `pollMs` sets how often
 * the script reads the machine and the snapshot. `egressTimeoutMs` and `snapshotTimeoutMs` set how
 * long it waits for an egress edit and the snapshot, and `egressInForceMs` how long it waits after
 * boxd reports an egress edit before it relies on the edit.
 */
export const build = async (
  boxd,
  options,
  {
    log,
    output,
    signal,
    pollMs = POLL_MS,
    egressTimeoutMs = EGRESS_TIMEOUT_MS,
    egressInForceMs = EGRESS_IN_FORCE_MS,
    snapshotTimeoutMs = SNAPSHOT_TIMEOUT_MS,
  },
) => {
  const egress = boxdEgress();
  const stamp = new Date().toISOString().replace(/[-:T]/gu, "").slice(0, 14);
  const name = `usine-snapshot-${stamp}-${process.pid}`;
  const spec = Machine.spec()
    .size(options.size)
    .isolated()
    .egress(...egress);
  const machine = await boxd.machines.create({ name, shared: true, spec });
  log(`Created temporary machine ${name}`);
  let removal;
  const remove = () =>
    (removal ??= boxd.machines.delete(machine.id).then(
      () => log(`Deleted temporary machine ${name}`),
      () => log(`Delete temporary machine ${name} in boxd`),
    ));
  signal.addEventListener("abort", remove, { once: true });
  try {
    throwIfAborted(signal);
    await boxd.machines.waitUntilReady(machine.id, { timeout: READY_TIMEOUT_MS });
    await boxd.machines.setAutoHibernateTimeout(machine.id, 0);
    await boxd.machines.setAutoSuspendTimeout(machine.id, 0);
    const polling = { signal, pollMs, timeoutMs: egressTimeoutMs };
    await boxd.machines.setEgressAllow(machine.id, []);
    await waitForEgress(boxd, machine.id, [], polling);
    await sleep(egressInForceMs);
    throwIfAborted(signal);
    const code = await runSetup(boxd, machine.id, options, { output, signal });
    throwIfAborted(signal);
    if (code !== 0) throw new Error(`The setup exited with code ${code}`);
    await boxd.machines.setEgressAllow(machine.id, egress);
    const restricted = await waitForEgress(boxd, machine.id, egress, polling);
    if (!sameEntries(restricted.spec?.egress ?? [], egress))
      throw new Error(
        "boxd didn't record the egress allowlist in the temporary machine's spec, so the snapshot would start unrestricted",
      );
    log(`Saving snapshot ${options.snapshot}`);
    await saveSnapshot(boxd, machine.id, options.snapshot, {
      signal,
      pollMs,
      timeoutMs: snapshotTimeoutMs,
    });
    return options.snapshot;
  } finally {
    signal.removeEventListener("abort", remove);
    await remove();
  }
};

if (import.meta.main) {
  const log = (message) => process.stderr.write(`${message}\n`);
  let options;
  try {
    options = parseOptions(process.argv.slice(2), process.env);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    log(`${error.message}\n${USAGE}`);
    process.exit(2);
  }
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort(130));
  process.once("SIGTERM", () => controller.abort(143));
  const boxd = new Boxd(clientOptions(options));
  try {
    const name = await build(boxd, options, {
      log,
      output: process.stderr,
      signal: controller.signal,
    });
    process.stdout.write(`${name}\n`);
  } catch (error) {
    log(String(error?.message ?? error).replaceAll(options.apiKey, "[redacted]"));
    process.exitCode = controller.signal.aborted ? controller.signal.reason : 1;
  } finally {
    await boxd.close();
  }
}
