import { Effect, Option } from "effect";
import { WorkerCapabilityError } from "../executor.ts";
import type { RemoteCommands } from "../remote/commands.ts";
import type { ContainerRuntime } from "../remote/runtime.ts";
import type { SshMachine } from "./model.ts";

const GIB = 1024 ** 3;

/** The free disk space in GiB that an SSH Worker's machine keeps unless `min_free_disk_gib` sets another. */
const DEFAULT_MIN_FREE_DISK_GIB = 10;

/**
 * A script that prints `df -Pk` for the directory `$1`, then the line of the image storage of
 * the container runtime `$2`, if any. Reports skipped storage checks on stderr.
 */
const FREE_DISK_SCRIPT = String.raw`
set -eu
df -Pk "$1"
case "$2" in
  docker) store=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null) || store= ;;
  podman) store=$(podman info --format '{{.Store.GraphRoot}}' 2>/dev/null) || store= ;;
  *) exit 0 ;;
esac
if [ -z "$store" ]; then
  printf 'usine-disk-storage-skipped: %s did not report its image storage path\n' "$2" >&2
elif storage_df=$(df -Pk "$store" 2>/dev/null); then
  printf '%s\n' "$storage_df" | tail -n +2
else
  printf 'usine-disk-storage-skipped: df could not read %s image storage at %s\n' "$2" "$store" >&2
fi
`.trim();

/** A filesystem that `df -Pk` reports, with its free space for unprivileged users. */
export interface FreeSpace {
  readonly mount: string;
  readonly availableBytes: number;
}

const DF_LINE = /^\S.*?\s+\d+\s+\d+\s+(?<available>\d+)\s+\d+%\s+(?<mount>\/.*)$/u;

/** Parses `df -Pk` output: one entry per mount point, in order, without the header. */
export const freeSpaceFromDf = (output: string): ReadonlyArray<FreeSpace> => {
  const filesystems = new Map<string, FreeSpace>();
  for (const line of output.split("\n")) {
    const groups = DF_LINE.exec(line.trim())?.groups;
    if (groups?.available === undefined || groups.mount === undefined) continue;
    if (!filesystems.has(groups.mount))
      filesystems.set(groups.mount, {
        mount: groups.mount,
        availableBytes: Number(groups.available) * 1024,
      });
  }
  return [...filesystems.values()];
};

const gib = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GiB`;

/**
 * Checks that the filesystems of the Worker's root and of the image storage of `runtime` each
 * have at least the Worker's `minFreeDiskGib` free. Fails with a `disk` capability error that
 * states the free space and the threshold.
 */
export const verifyFreeDisk = Effect.fn("SshExecutor.verifyFreeDisk")(function* (
  commands: RemoteCommands,
  machine: SshMachine,
  runtime: Option.Option<ContainerRuntime>,
  operation: "preflight" | "prepare",
) {
  const worker = machine.address.name;
  const host = machine.shell.destination;
  const thresholdGib = machine.address.minFreeDiskGib ?? DEFAULT_MIN_FREE_DISK_GIB;
  const fields = { worker, host, operation, thresholdGib };
  yield* Effect.annotateCurrentSpan(fields);
  if (thresholdGib === 0) {
    yield* Effect.logInfo("SSH Worker free disk space check is disabled", fields);
    return;
  }
  const read = yield* commands.inspect(operation, machine.shell, "sh", [
    "-c",
    FREE_DISK_SCRIPT,
    "sh",
    machine.address.root,
    Option.getOrElse(runtime, () => ""),
  ]);
  for (const line of read.stderr.split("\n")) {
    const prefix = "usine-disk-storage-skipped: ";
    if (line.startsWith(prefix))
      yield* Effect.logInfo("Skipped SSH Worker image storage disk check", {
        ...fields,
        reason: line.slice(prefix.length),
      });
  }
  const filesystems = freeSpaceFromDf(read.stdout);
  const lowest = filesystems.reduce<FreeSpace | undefined>(
    (current, filesystem) =>
      current === undefined || filesystem.availableBytes < current.availableBytes
        ? filesystem
        : current,
    undefined,
  );
  if (read.exitCode !== 0 || lowest === undefined)
    return yield* WorkerCapabilityError.make({
      worker,
      capability: "disk",
      message: `Can't read the free disk space of SSH worker "${worker}" at ${host}`,
      cause: new Error(read.stderr.trim() || `df exited with code ${read.exitCode}`),
    });
  const free = filesystems.map(({ mount, availableBytes }) => `${mount}=${gib(availableBytes)}`);
  if (lowest.availableBytes < thresholdGib * GIB) {
    yield* Effect.logWarning("SSH Worker has less free disk space than its threshold", {
      ...fields,
      free: free.join(","),
    });
    return yield* WorkerCapabilityError.make({
      worker,
      capability: "disk",
      message: `SSH worker "${worker}" has ${gib(lowest.availableBytes)} free on ${lowest.mount}, below its threshold of ${thresholdGib} GiB. Free disk space on the machine, or change min_free_disk_gib in the worker's configuration.`,
      cause: new Error(free.join(", ")),
    });
  }
  yield* Effect.logInfo("SSH Worker has enough free disk space", {
    ...fields,
    free: free.join(","),
  });
});
