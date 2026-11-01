import type { RemoteShell } from "@usine/agents/child-host";
import type { WorkerName, ContainerLimits } from "@usine/core/worker";
import { Effect, Option, Schema } from "effect";
import { WorkerCapabilityError } from "../executor.ts";
import type { RemoteCommands } from "../remote/commands.ts";
import { ContainerRuntime } from "../remote/runtime.ts";
import type { SshMachine } from "./model.ts";

/** Exit 3 means no runtime and no root-equivalent Docker access; 4 means socket access without a CLI. */
export const DETECT_SCRIPT = String.raw`
set -eu
if [ -f "$1" ]; then
  runtime=$(cat "$1")
elif command -v podman >/dev/null 2>&1; then
  runtime=podman
elif command -v docker >/dev/null 2>&1; then
  runtime=docker
else
  for group in $(id -nG); do
    if [ "$group" = docker ]; then exit 4; fi
  done
  if [ -w /var/run/docker.sock ]; then exit 4; fi
  exit 3
fi
case "$runtime" in
  podman) printf 'podman\n'; exec podman info --format json ;;
  docker) printf 'docker\n'; exec docker version -f '{{.Server.Version}}' ;;
  *) echo 'Set /etc/usine/container-runtime to podman or docker' >&2; exit 1 ;;
esac
`.trim();

const ROOTLESS_SESSION_SCRIPT = String.raw`
set -eu
[ "$(id -u)" != 0 ] || { echo 'Use an unprivileged SSH user'; exit 1; }
for group in $(id -nG); do
  if [ "$group" = docker ]; then echo 'Remove the SSH user from the docker group'; exit 1; fi
done
[ ! -w /var/run/docker.sock ] || { echo 'Remove SSH user access to the system Docker socket'; exit 1; }
for file in /etc/subuid /etc/subgid; do
  awk -F: -v name="$(id -un)" -v uid="$(id -u)" '
    { names[NR]=$1; starts[NR]=$2; ends[NR]=$2+$3 }
    ($1 == name || $1 == uid) && $3 >= 65536 { found=1 }
    END {
      for (i=1; i<=NR; i++) if (names[i] == name || names[i] == uid)
        for (j=1; j<=NR; j++) if (i != j && starts[i] < ends[j] && starts[j] < ends[i]) exit 1
      if (!found) exit 1
    }
  ' "$file" || { echo "Allocate non-overlapping ranges of at least 65536 IDs in $file for the SSH user"; exit 1; }
done
[ "$(loginctl show-user "$(id -un)" -p Linger --value)" = yes ] || {
  echo 'Enable lingering with loginctl enable-linger <SSH user>'; exit 1;
}
[ -d "$(printenv XDG_RUNTIME_DIR)" ] || {
  echo 'Install libpam-systemd and dbus-user-session, then reconnect over SSH'; exit 1;
}
systemctl --user is-active --quiet default.target || {
  echo 'Start the systemd user manager and reconnect over SSH'; exit 1;
}
`.trim();

// Podman 5.4's libpod/define/info.go; extra vendor fields are ignored at this boundary.
const PodmanInfo = Schema.Struct({
  version: Schema.Struct({ Version: Schema.NonEmptyString }),
  host: Schema.Struct({
    security: Schema.Struct({ rootless: Schema.Literal(true) }),
    serviceIsRemote: Schema.Literal(false),
    cgroupVersion: Schema.Literal("v2"),
    cgroupManager: Schema.Literal("systemd"),
    cgroupControllers: Schema.Array(Schema.String).check(
      Schema.makeFilter(
        (controllers) => ["cpu", "memory", "pids"].every((name) => controllers.includes(name)),
        { message: "Delegate cpu, memory, and pids to the systemd user manager" },
      ),
    ),
    kernel: Schema.NonEmptyString,
    ociRuntime: Schema.Struct({ name: Schema.NonEmptyString, version: Schema.NonEmptyString }),
  }),
}).pipe(Schema.fromJsonString);

const gap = (worker: WorkerName, message: string, cause: unknown) =>
  new WorkerCapabilityError({ worker, capability: "container", message, cause });

export const detectRuntime = Effect.fn("SshExecutor.detectContainerRuntime")(function* (
  commands: RemoteCommands,
  machine: SshMachine,
) {
  const fields = { worker: machine.address.name, host: machine.shell.destination };
  yield* Effect.annotateCurrentSpan(fields);
  const result = yield* commands.inspect("preflight", machine.shell, "sh", [
    "-c",
    DETECT_SCRIPT,
    "sh",
    "/etc/usine/container-runtime",
  ]);
  if (result.exitCode === 3 && result.stdout.trim() === "") {
    yield* Effect.logWarning("No container runtime is installed", fields);
    return Option.none<ContainerRuntime>();
  }
  const [name, ...details] = result.stdout.trim().split("\n");
  // Check host prerequisites even when podman info failed before it could report them.
  if (name === "podman") {
    const session = yield* commands.inspect("preflight", machine.shell, "sh", [
      "-c",
      ROOTLESS_SESSION_SCRIPT,
    ]);
    if (session.exitCode !== 0)
      return yield* gap(
        fields.worker,
        `Rootless Podman setup on ${fields.host}: ${session.stdout.trim()} ${session.stderr.trim()}`,
        new Error(`session check exited with code ${session.exitCode}`),
      );
  }
  if (result.exitCode !== 0)
    return yield* gap(
      fields.worker,
      result.exitCode === 4
        ? `The SSH user of worker "${fields.worker}" can use Docker's socket, but the docker CLI isn't installed. Install it or remove Docker access.`
        : `Can't inspect the container runtime on ${fields.host}. For Docker, start the daemon and add the user to the docker group. For Podman, repair its rootless setup. ${result.stderr.trim()}`,
      new Error(`runtime detection exited with code ${result.exitCode}`),
    );
  const runtime = yield* Schema.decodeUnknownEffect(ContainerRuntime)(name).pipe(
    Effect.mapError((cause) =>
      gap(fields.worker, "The worker returned an unknown container runtime", cause),
    ),
  );
  if (runtime === "podman") {
    const info = yield* Schema.decodeUnknownEffect(PodmanInfo)(details.join("\n")).pipe(
      Effect.mapError((cause) =>
        gap(
          fields.worker,
          "Podman requires local rootless mode, cgroup v2, and systemd delegation of cpu, memory, and pids. Configure Delegate=cpu cpuset io memory pids in user@.service, enable lingering, and reconnect over SSH.",
          cause,
        ),
      ),
    );
    yield* Effect.logInfo("Verified rootless Podman runtime", {
      ...fields,
      runtime,
      version: info.version.Version,
      kernel: info.host.kernel,
      ociRuntime: info.host.ociRuntime.name,
      ociVersion: info.host.ociRuntime.version,
      cgroupVersion: info.host.cgroupVersion,
      controllers: info.host.cgroupControllers,
    });
  } else {
    if (details.join("").trim() === "")
      return yield* gap(
        fields.worker,
        "Docker returned no server version",
        new Error("empty version"),
      );
    yield* Effect.logInfo("Verified Docker runtime", {
      ...fields,
      runtime,
      version: details.join("\n"),
    });
  }
  return Option.some(runtime);
});

export const PODMAN_LIMITS_SCRIPT = String.raw`
read quota period < /sys/fs/cgroup/cpu.max
awk -v q="$quota" -v p="$period" -v cpus="$1" 'BEGIN { exit !(q != "max" && p > 0 && q == int(cpus * p)) }'
[ "$(cat /sys/fs/cgroup/memory.max)" = "$2" ]
[ "$(cat /sys/fs/cgroup/memory.swap.max)" = 0 ]
[ "$(cat /sys/fs/cgroup/pids.max)" = "$3" ]
`;

/** Reads the limits from the same cgroup used by exec and OOM accounting. */
export const verifyPodmanLimits = Effect.fn("SshExecutor.verifyPodmanLimits")(function* (
  commands: RemoteCommands,
  shell: RemoteShell,
  worker: WorkerName,
  limits: ContainerLimits,
) {
  yield* Effect.annotateCurrentSpan({ worker, host: shell.destination });
  const checked = yield* commands.inspect("preflight", shell, "sh", [
    "-ec",
    PODMAN_LIMITS_SCRIPT,
    "sh",
    String(limits.cpus),
    String(limits.memoryMib * 1024 ** 2),
    String(limits.pids),
  ]);
  if (checked.exitCode !== 0)
    return yield* gap(
      worker,
      "Podman did not enforce the configured CPU, memory, zero-swap, and PID limits. Repair cgroup v2 controller delegation and the OCI runtime before running attempts.",
      new Error(checked.stderr.trim() || `cgroup probe exited with code ${checked.exitCode}`),
    );
  yield* Effect.logInfo("Verified Podman cgroup limits through exec", { worker, ...limits });
});
