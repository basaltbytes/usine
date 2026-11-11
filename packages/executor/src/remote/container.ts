import { catalog } from "@usine/agents/harness";
import {
  CHILD_KILL_SCRIPT,
  ExecShell,
  type RemoteHost,
  RemoteShell,
  type ShellContainer,
} from "@usine/agents/child-host";
import type { Harness } from "@usine/core/agent/brain";
import {
  type AttemptId,
  ContainerOutOfMemoryKills,
  MAX_KILLED_PROCESSES,
} from "@usine/core/attempt";
import type { Sink } from "@usine/core/attempt/channel";
import type { InstanceId } from "@usine/core/instance";
import { safeSegment } from "@usine/core/repository";
import {
  ContainerId,
  type ContainerImage,
  type ContainerLimits,
  type ContainerScratchMib,
  type WorkerName,
} from "@usine/core/worker";
import { Duration, Effect, Option, Redacted, Ref, Schema } from "effect";
import { type ExecutorOperation, ExecutorOperationError } from "../executor.ts";
import type { RemoteCommands } from "./commands.ts";
import { type ContainerRuntime, runtimeOptions } from "./runtime.ts";
import { readKilledProcesses } from "./memory.ts";

export const PNPM_STORE_VOLUME = "usine-pnpm-store";
export const PNPM_STORE_PATH = "/home/usine/.local/share/pnpm/store";
export const PNPM_STORE_MOUNT = `${PNPM_STORE_VOLUME}:${PNPM_STORE_PATH}:nocopy`;

const decodeRunDuration = Schema.decodeUnknownEffect(
  Schema.NonEmptyString.pipe(
    Schema.decodeTo(
      Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    ),
  ),
);

const SHARED_CACHES = [
  { volume: PNPM_STORE_VOLUME, path: PNPM_STORE_PATH },
  {
    volume: "usine-turbo-cache",
    path: "/home/usine/.cache/turbo",
  },
].map(({ volume, path }) => ({
  volume,
  path,
  mount: `${volume}:${path}:nocopy`,
}));

/** Initializes volume `$3` using runtime `$1`, image `$2`, mount `$4`, and path `$5`. */
export const PREPARE_CACHE_SCRIPT = String.raw`
set -eu
"$1" volume create "$3" >/dev/null
runtime=$1 image=$2 volume=$3 mount=$4 path=$5
shift 5
if [ "$runtime" = podman ]; then set -- --userns=keep-id --cgroupns=private --http-proxy=false; fi
started=$(date +%s%3N) || started=
status=0
"$runtime" run --rm --network none "$@" --user 0 --volume "$mount" --entrypoint sh "$image" -ec '
  owner=$(id -u usine)
  current=$(stat -c %u "$1")
  if [ "$current" = "$owner" ]; then exit 0; fi
  if [ "$current" != 0 ] || [ -n "$(find "$1" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    echo "Cache volume $2 belongs to UID $current, but the image usine user has UID $owner. Remove containers that reference it, then run: $3 volume rm $2" >&2
    exit 1
  fi
  chmod 0755 "$1"
  chown -h "$owner" "$1"
' sh "$path" "$volume" "$runtime" || status=$?
finished=$(date +%s%3N) || finished=
case "$started:$finished" in
  *[!0-9:]*|:*|*:) printf '%s\n' "$started:$finished" ;;
  *) printf '%s\n' "$((finished - started))" ;;
esac
exit "$status"
`.trim();

/** The labels on each container, so a later process finds the ones it left. */
const INSTANCE_LABEL = "dev.usine.instance";
const INSTANCE_ID_LABEL = "dev.usine.instance-id";
const PROCESS_LABEL = "dev.usine.process";
const WORKER_LABEL = "dev.usine.worker";
const ATTEMPT_LABEL = "dev.usine.attempt";
/** The label of a preflight's container, which removes itself and never needs a sweep. */
const PREFLIGHT_LABEL = "dev.usine.preflight";
/** The lifetime of a preflight's container if no process removes it, in seconds. */
const PREFLIGHT_CONTAINER_SECONDS = 900;

/** The home directory of the image's `usine` user (`infra/worker-image/Dockerfile`). */
const CONTAINER_HOME = "/home/usine";
/** The image's entrypoint copies the files under this directory into `CONTAINER_HOME`. */
const SEED_DIRECTORY = "/usr/local/share/usine/seed";

/** The image and limits of each Attempt container on a Worker. */
export interface ContainerSettings {
  /** Identifies the executor that started the container across connection aliases. */
  readonly process: string;
  readonly runtime: ContainerRuntime;
  readonly hosts: Readonly<Record<string, string>>;
  readonly image: ContainerImage;
  readonly limits: ContainerLimits;
  readonly shmSizeMib: ContainerScratchMib;
  readonly tmpfsSizeMib: ContainerScratchMib;
  /** The value of the instance label, which the instances that share a GitHub App share too. */
  readonly instance: string;
  /** The value of the instance ID label, which tells apart the instances that share the App. */
  readonly instanceId: InstanceId;
}

/** How a Worker runs an Attempt's commands on its machine. */
export type AttemptIsolation =
  /** The SSH user's shell runs every command, so concurrent Attempts can read each other's files and processes. */
  | { readonly _tag: "SharedUser" }
  /** Each Attempt's commands run in its own container; the SSH user's shell runs only the container's lifecycle and the cached clone's fetch. */
  | { readonly _tag: "Container"; readonly settings: ContainerSettings };

export const sharedUser: AttemptIsolation = { _tag: "SharedUser" };

/** Returns the name of `attemptId`'s container. */
export const attemptContainerName = (attemptId: AttemptId): string =>
  `usine-${safeSegment(attemptId)}`;

/**
 * Returns the file whose presence records that `attemptId`'s checkout was mounted in a
 * container. It's outside every container's mounts, so no Attempt can create or remove it.
 */
export const containerCheckoutMarker = (workerDirectory: string, attemptId: AttemptId): string =>
  `${workerDirectory}/container-checkouts/${safeSegment(attemptId)}`;

/** A script that creates the empty file `$1` and its directory. */
const MARK_SCRIPT = 'mkdir -p "$(dirname "$1")" && : > "$1"';

/** A machine directory mounted writable at a container path. */
export interface WritableMount {
  readonly source: string;
  readonly destination: string;
}

/** One container to start on a machine. */
export interface ContainerSpec {
  readonly name: string;
  readonly settings: ContainerSettings;
  readonly worker: WorkerName;
  /** The Attempt whose commands the container runs, or `None` for a preflight's container. */
  readonly attemptId: Option.Option<AttemptId>;
  /**
   * The Attempt's checkout, mounted read-write at its own path, and the directory that contains
   * it, which is an empty directory in the container for the children's PID files.
   */
  readonly checkout: Option.Option<{ readonly path: string; readonly parent: string }>;
  /** Machine directories mounted read-only at their own paths. */
  readonly readOnly: ReadonlyArray<string>;
  /** Machine directories of the Attempt mounted read-write. */
  readonly writable: ReadonlyArray<WritableMount>;
  /** The harnesses whose login files the container gets. */
  readonly harnesses: ReadonlyArray<Harness>;
  /** Variables set in the container without secrets. */
  readonly environment: Readonly<Record<string, string>>;
  /** Variables set in the container through the container CLI's standard input, never a command line. */
  readonly secrets: Readonly<Record<string, Redacted.Redacted<string>>>;
}

/**
 * A script that removes a container named `$2` left from an earlier start, then prints the SSH
 * user's home and each of the following arguments that exists: the first `$3` are absolute
 * paths, and the rest are paths under the home.
 */
const PREPARE_SCRIPT = String.raw`
"$1" rm -f "$2" >/dev/null 2>&1 || true
printf '%s\n' "$HOME"
absolute=$3
shift 3
while [ "$#" -gt 0 ]; do
  if [ "$absolute" -gt 0 ]; then path=$1; absolute=$((absolute - 1)); else path=$HOME/$1; fi
  if test -e "$path"; then printf '%s\n' "$1"; fi
  shift
done
`.trim();

/**
 * A script that stops the children recorded in container `$2` for the checkout `$4` with the
 * kill script `$3`. Prints `no-container` if the container doesn't exist and
 * `container-stopped` if it doesn't run, since then no child can run in it.
 */
export const STOP_CHILDREN_SCRIPT = String.raw`
if ! state=$("$1" container inspect --format '{{.State.Running}}' "$2" 2>&1); then
  case "$state" in
    *"No such"*|*"no such container"*) echo no-container; exit 0 ;;
  esac
  printf '%s\n' "$state" >&2
  exit 1
fi
if [ "$state" != true ]; then echo container-stopped; exit 0; fi
exec "$1" exec "$2" sh -c "$3" sh "$4"
`.trim();

/** The `container inspect` format of a container's status, exit code, and out-of-memory kill. */
const STATE_FORMAT = "{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}";

/**
 * A script that prints `container <ID>` for container `$2`, then the `memory.events` of its
 * cgroup if it runs, or `oom_kill 1` if it stopped because the kernel killed its init for memory.
 */
const MEMORY_EVENTS_SCRIPT = String.raw`
state=$("$1" container inspect --format '{{.Id}} {{.State.Running}} {{.State.OOMKilled}}' "$2") || exit 1
set -- "$1" "$2" $state
echo "container $3"
case "$4 $5" in
  "true "*) exec "$1" exec "$2" cat /sys/fs/cgroup/memory.events ;;
  *" true") echo "oom_kill 1" ;;
  *) echo "oom_kill 0" ;;
esac
`.trim();

/** The container's ID in the output of `MEMORY_EVENTS_SCRIPT`. */
const CONTAINER_LINE = /^container (\S*)$/mu;

/** The count of processes that the kernel killed for memory in a cgroup's `memory.events`. */
const OOM_KILL_LINE = /^oom_kill (\d+)$/mu;

const decodeContainerId = Schema.decodeUnknownEffect(ContainerId);

/**
 * A script that lists the containers with both labels `$2` and `$3`, one `<name> <process>` line
 * each. Prints nothing if the machine has no container CLI.
 */
const LIST_SCRIPT = String.raw`
command -v "$1" >/dev/null 2>&1 || exit 0
exec "$1" ps --all --filter "label=$2" --filter "label=$3" --format '{{.Names}} {{.Label "dev.usine.process"}}'
`.trim();

/**
 * A script that runs `$@` with this script's standard input through a pipe. `docker run
 * --env-file /dev/stdin` can't open a socket, which sshd and some process spawners give as
 * standard input.
 */
const PIPED_STDIN_SCRIPT = 'cat | "$@"';

/** Returns a CSV field of a `--mount` option, quoted so a comma in a path is kept. */
const field = (key: string, value: string): string => `"${key}=${value.replaceAll('"', '""')}"`;

const bindMount = (source: string, destination: string, access: "readonly" | "writable") =>
  [
    "type=bind",
    field("source", source),
    field("destination", destination),
    ...(access === "readonly" ? ["readonly"] : []),
  ].join(",");

/** Returns the `--env-file` content for `variables`. Fails on a value the file format can't hold. */
const environmentFile = (
  operation: ExecutorOperation,
  variables: Readonly<Record<string, string>>,
): Effect.Effect<Redacted.Redacted<string>, ExecutorOperationError> => {
  const entries = Object.entries(variables);
  const multiline = entries.find(([, value]) => value.includes("\n"));
  if (multiline !== undefined)
    return Effect.fail(
      ExecutorOperationError.make({
        operation,
        message: `Can't set ${multiline[0]} in a container: its value has a line break`,
        cause: new Error(`${multiline[0]} has a line break`),
      }),
    );
  return Effect.succeed(
    Redacted.make(entries.map(([name, value]) => `${name}=${value}\n`).join("")),
  );
};

/** Returns the log fields of the container of `spec` on the machine of `shell`. */
const containerFields = (shell: RemoteHost, spec: ContainerSpec) => ({
  worker: spec.worker,
  host: shell.destination,
  container: spec.name,
  image: spec.settings.image,
  runtime: spec.settings.runtime,
  ...Option.match(spec.attemptId, {
    onNone: () => ({}),
    onSome: (attemptId) => ({ attemptId }),
  }),
});

/** Returns the shell that runs commands in the container `name` on the machine of `shell`. */
const containerShell = (shell: RemoteHost, name: string, runtime: ContainerRuntime): RemoteHost => {
  const container: ShellContainer = { runtime, name };
  return shell._tag === "RemoteShell"
    ? RemoteShell.make({
        ssh: shell.ssh,
        sshEnvironment: shell.sshEnvironment,
        destination: shell.destination,
        container,
      })
    : ExecShell.make({ transport: shell.transport, destination: shell.destination, container });
};

/**
 * Returns the operations on the containers of a machine: start one for an Attempt or a
 * preflight, stop an Attempt's children in it, and remove the containers that an earlier
 * process left.
 */
export const containersFor = (commands: RemoteCommands) => {
  const prepareCaches = Effect.fn("RemoteExecutor.prepareSharedCaches")(function* (
    operation: ExecutorOperation,
    shell: RemoteHost,
    image: ContainerImage,
    worker: WorkerName,
    runtime: ContainerRuntime,
  ) {
    const fields = { worker, host: shell.destination, image, runtime };
    yield* Effect.annotateCurrentSpan(fields);
    for (const { volume, mount, path } of SHARED_CACHES) {
      const [duration, prepared] = yield* commands
        .inspect(operation, shell, "sh", [
          "-c",
          PREPARE_CACHE_SCRIPT,
          "sh",
          runtime,
          image,
          volume,
          mount,
          path,
        ])
        .pipe(Effect.timed);
      if (prepared.exitCode !== 0) {
        const message = `Can't prepare shared cache volume ${volume}: ${prepared.stderr.trim() || `exit code ${prepared.exitCode}`}`;
        yield* Effect.logWarning(message, {
          ...fields,
          volume,
          durationMillis: Duration.toMillis(duration),
          exitCode: prepared.exitCode,
        });
        return yield* ExecutorOperationError.make({
          operation,
          message,
          cause: new Error(prepared.stderr),
        });
      }
      const runTiming = yield* decodeRunDuration(prepared.stdout.trim()).pipe(
        Effect.map((runDurationMillis) => ({ runDurationMillis })),
        Effect.catchTag("SchemaError", () =>
          Effect.logDebug("Could not read the shared cache container run duration", {
            ...fields,
            volume,
            stdout: prepared.stdout,
          }).pipe(Effect.as({})),
        ),
      );
      yield* Effect.logInfo("Prepared shared cache volume", {
        ...fields,
        volume,
        path,
        ...runTiming,
        durationMillis: Duration.toMillis(duration),
      });
    }
  });

  const remove = Effect.fn("RemoteExecutor.removeContainer")(function* (
    shell: RemoteHost,
    name: string,
    runtime: ContainerRuntime,
  ) {
    yield* Effect.annotateCurrentSpan({ host: shell.destination, container: name });
    yield* commands.run("cleanup", shell, runtime, ["rm", "--force", "--volumes", name]).pipe(
      Effect.tap(() =>
        Effect.logInfo("Removed the container", { host: shell.destination, container: name }),
      ),
      Effect.tapError((error) =>
        Effect.logWarning(
          "Could not remove the container; the next process that uses the Worker removes it",
          { host: shell.destination, container: name, message: error.message },
        ),
      ),
      Effect.ignore,
    );
  });

  /**
   * Starts the container of `spec` on the machine of `shell`, replacing one with the same name,
   * and removes it when the caller's scope closes. Returns the shell that runs commands in it.
   */
  const start = Effect.fn("RemoteExecutor.startContainer")(function* (
    operation: ExecutorOperation,
    shell: RemoteHost,
    spec: ContainerSpec,
  ) {
    const fields = containerFields(shell, spec);
    yield* Effect.annotateCurrentSpan(fields);
    const logins = spec.harnesses.flatMap((harness) =>
      Option.toArray(catalog.get(harness)).flatMap(({ worker }) => [
        ...worker.login.mounted.map((file) => ({ file, mounted: true })),
        ...worker.login.seeded.map((file) => ({ file, mounted: false })),
      ]),
    );
    const [home = "", ...present] = (yield* commands.run(operation, shell, "sh", [
      "-c",
      PREPARE_SCRIPT,
      "sh",
      spec.settings.runtime,
      spec.name,
      String(spec.readOnly.length + spec.writable.length),
      ...spec.readOnly,
      ...spec.writable.map(({ source }) => source),
      ...logins.map(({ file }) => file),
    ])).split("\n");
    if (!home.startsWith("/"))
      return yield* ExecutorOperationError.make({
        operation,
        message: "The SSH user's home on the machine isn't an absolute path",
        cause: new Error(home),
      });
    const found = logins.filter(({ file }) => present.includes(file));
    const readOnly = spec.readOnly.filter((path) => present.includes(path));
    const writable = spec.writable.filter(({ source }) => present.includes(source));
    const missing = [...spec.readOnly, ...spec.writable.map(({ source }) => source)].filter(
      (path) => !present.includes(path),
    );
    if (missing.length > 0)
      yield* Effect.logWarning("The container doesn't mount these missing machine paths", {
        ...fields,
        missing: missing.join(","),
      });
    const envFile = yield* environmentFile(operation, {
      ...spec.environment,
      TMPDIR: "/tmp",
      ...Object.fromEntries(
        Object.entries(spec.secrets).map(([name, value]) => [name, Redacted.value(value)]),
      ),
    });
    const lifetime = Option.match(spec.attemptId, {
      onNone: () => ({
        labels: [`${PREFLIGHT_LABEL}=${spec.worker}`],
        options: ["--rm"],
        command: ["sleep", String(PREFLIGHT_CONTAINER_SECONDS)],
      }),
      onSome: (attemptId) => ({
        labels: [
          `${INSTANCE_LABEL}=${spec.settings.instance}`,
          `${INSTANCE_ID_LABEL}=${spec.settings.instanceId}`,
          `${WORKER_LABEL}=${spec.worker}`,
          `${PROCESS_LABEL}=${spec.settings.process}`,
          `${ATTEMPT_LABEL}=${attemptId}`,
        ],
        options: [],
        command: [],
      }),
    });
    const mounts = [
      ...Option.match(spec.checkout, {
        onNone: () => [],
        onSome: ({ path, parent }) => [
          ["type=tmpfs", field("destination", parent), "tmpfs-mode=1777"].join(","),
          bindMount(path, path, "writable"),
        ],
      }),
      ...readOnly.map((path) => bindMount(path, path, "readonly")),
      ...writable.map(({ source, destination }) => bindMount(source, destination, "writable")),
      ...found.map(({ file, mounted }) =>
        mounted
          ? bindMount(`${home}/${file}`, `${CONTAINER_HOME}/${file}`, "writable")
          : bindMount(`${home}/${file}`, `${SEED_DIRECTORY}/${file}`, "readonly"),
      ),
    ];
    // Host networking keeps the machine's nftables rules, which admit only the Gateway, in front
    // of the container (ADR 0027, amended 2026-10-25).
    const args = [
      "run",
      ...runtimeOptions(spec.settings.runtime),
      "--detach",
      "--name",
      spec.name,
      ...lifetime.options,
      ...lifetime.labels.flatMap((label) => ["--label", label]),
      "--network",
      "host",
      ...Object.entries(spec.settings.hosts).flatMap(([host, address]) => [
        "--add-host",
        `${host}:${address}`,
      ]),
      "--cpus",
      String(spec.settings.limits.cpus),
      "--memory",
      `${spec.settings.limits.memoryMib}m`,
      "--memory-swap",
      `${spec.settings.limits.memoryMib}m`,
      "--pids-limit",
      String(spec.settings.limits.pids),
      "--shm-size",
      `${spec.settings.shmSizeMib}m`,
      "--tmpfs",
      `/tmp:rw,exec,nosuid,nodev,size=${spec.settings.tmpfsSizeMib}m,mode=1777`,
      "--env-file",
      "/dev/stdin",
      ...SHARED_CACHES.flatMap(({ mount }) => ["--volume", mount]),
      ...mounts.flatMap((mount) => ["--mount", mount]),
      spec.settings.image,
      ...lifetime.command,
    ];
    yield* Effect.addFinalizer(() =>
      remove(shell, spec.name, spec.settings.runtime).pipe(Effect.orDie),
    );
    yield* commands
      .runWithInput(
        operation,
        shell,
        "sh",
        ["-c", PIPED_STDIN_SCRIPT, "sh", spec.settings.runtime, ...args],
        envFile,
      )
      .pipe(Effect.ensuring(Effect.sync(() => Redacted.wipeUnsafe(envFile))));
    yield* Effect.logInfo("Started the container", {
      ...fields,
      shmSizeMib: spec.settings.shmSizeMib,
      tmpfsSizeMib: spec.settings.tmpfsSizeMib,
      logins: found.map(({ file }) => file).join(","),
      readOnly: readOnly.join(","),
    });
    return containerShell(shell, spec.name, spec.settings.runtime);
  });

  /**
   * Stops the children recorded in the container `name` for the checkout `worktree`. Succeeds
   * without stopping anything if the container doesn't exist or doesn't run.
   */
  const stopChildren = Effect.fn("RemoteExecutor.stopContainerChildren")(function* (
    operation: ExecutorOperation,
    shell: RemoteHost,
    name: string,
    worktree: string,
    runtime: ContainerRuntime,
  ) {
    yield* Effect.annotateCurrentSpan({ host: shell.destination, container: name, worktree });
    const outcome = yield* commands.run(operation, shell, "sh", [
      "-c",
      STOP_CHILDREN_SCRIPT,
      "sh",
      runtime,
      name,
      CHILD_KILL_SCRIPT,
      worktree,
    ]);
    yield* Effect.logInfo("Confirmed no child of the Attempt runs in its container", {
      host: shell.destination,
      container: name,
      worktree,
      children: outcome.trim().split("\n"),
    });
  });

  /**
   * Starts the container of `spec` again if it stopped, such as after an out-of-memory kill or a
   * signal to its init. Returns `running` if it still ran, else `started`, or `startedAfterOomKill`
   * if the kernel killed its init for memory. The scope that started it still removes it. Fails if
   * it doesn't exist.
   */
  const ensureRunning = Effect.fn("RemoteExecutor.ensureContainerRunning")(function* (
    operation: ExecutorOperation,
    shell: RemoteHost,
    spec: ContainerSpec,
  ) {
    const fields = containerFields(shell, spec);
    yield* Effect.annotateCurrentSpan(fields);
    const [status = "", exitCode = "", oomKilled = ""] = (yield* commands.run(
      operation,
      shell,
      spec.settings.runtime,
      ["container", "inspect", "--format", STATE_FORMAT, spec.name],
    ))
      .trim()
      .split(" ");
    if (status === "running") {
      yield* Effect.logDebug("The container still runs", fields);
      return "running" as const;
    }
    yield* Effect.logWarning("The container stopped; starting it again", {
      ...fields,
      status,
      exitCode,
      oomKilled,
    });
    yield* commands.run(operation, shell, spec.settings.runtime, ["start", spec.name]);
    return oomKilled === "true" ? ("startedAfterOomKill" as const) : ("started" as const);
  });

  /**
   * Returns the ID of the container of `spec` and the number of processes that the kernel killed
   * in it because it reached its memory limit: the count of its cgroup while it runs, or 1 if it
   * stopped because the kernel killed its init. A start creates a new cgroup, so the count
   * restarts at 0.
   */
  const outOfMemoryKills = Effect.fn("RemoteExecutor.containerOutOfMemoryKills")(function* (
    operation: ExecutorOperation,
    shell: RemoteHost,
    spec: ContainerSpec,
  ) {
    const fields = containerFields(shell, spec);
    yield* Effect.annotateCurrentSpan(fields);
    const events = yield* commands.run(operation, shell, "sh", [
      "-c",
      MEMORY_EVENTS_SCRIPT,
      "sh",
      spec.settings.runtime,
      spec.name,
    ]);
    const container = yield* decodeContainerId(CONTAINER_LINE.exec(events)?.[1]).pipe(
      Effect.mapError((cause) =>
        ExecutorOperationError.make({
          operation,
          message: "The container runtime didn't print the container's ID",
          cause,
        }),
      ),
    );
    const count = OOM_KILL_LINE.exec(events)?.[1];
    if (count === undefined)
      return yield* ExecutorOperationError.make({
        operation,
        message: "The container runtime returned no OOM counter",
        cause: new Error("missing oom_kill"),
      });
    const kills = Number(count);
    if (kills === 0)
      yield* Effect.logDebug("The kernel killed no process in the container", {
        ...fields,
        containerId: container,
      });
    else
      yield* Effect.logWarning("The kernel killed processes in the container for memory", {
        ...fields,
        containerId: container,
        kills,
        memoryMib: spec.settings.limits.memoryMib,
      });
    return { container, kills };
  });

  /** Tracks kills across container restarts and records them before removal. */
  const trackMemory = Effect.fn("RemoteExecutor.trackContainerMemory")(function* (
    shell: RemoteHost,
    spec: ContainerSpec,
  ) {
    const fields = containerFields(shell, spec);
    yield* Effect.annotateCurrentSpan(fields);
    const recorder = yield* Ref.make(Option.none<Sink["outOfMemory"]>());
    // A start gives the container a new cgroup whose count restarts at 0, so the kernel logs
    // keep the only trace of the processes killed before it, a killed init included.
    const starts = yield* Ref.make(0);
    const killedInits = yield* Ref.make(0);
    const recordKills = Effect.fn("RemoteExecutor.recordContainerOutOfMemoryKills")(
      function* () {
        yield* Effect.annotateCurrentSpan(fields);
        const record = yield* Ref.get(recorder);
        if (Option.isNone(record))
          return yield* Effect.logDebug(
            "No launch ran in the container, so its out-of-memory kills aren't read",
            fields,
          );
        const { container, kills: counted } = yield* outOfMemoryKills("cleanup", shell, spec);
        const kills = counted + (yield* Ref.get(killedInits));
        const started = yield* Ref.get(starts);
        if (kills === 0 && started === 0)
          return yield* Effect.logDebug("The kernel killed no process in the container", fields);
        const processes = yield* readKilledProcesses(
          commands,
          shell,
          spec.settings.runtime,
          spec.name,
          container,
        );
        if (processes.length < kills)
          yield* Effect.logWarning("Kernel OOM details are incomplete", {
            ...fields,
            container,
            kills,
            identified: processes.length,
          });
        const recorded = Math.max(kills, processes.length);
        if (recorded === 0)
          return yield* Effect.logDebug(
            "The kernel logs name no process killed in the container before its starts",
            { ...fields, container, starts: started },
          );
        if (processes.length > MAX_KILLED_PROCESSES)
          yield* Effect.logWarning("Recording only the first killed processes", {
            ...fields,
            container,
            identified: processes.length,
            kept: MAX_KILLED_PROCESSES,
          });
        yield* record.value(
          ContainerOutOfMemoryKills.make({
            container,
            kills: recorded,
            processes: processes.slice(0, MAX_KILLED_PROCESSES),
            memoryMib: spec.settings.limits.memoryMib,
          }),
        );
      },
      Effect.tapError((error) =>
        Effect.logWarning(
          "Could not record the processes the kernel killed in the Attempt's container",
          { ...fields, errorTag: error._tag, message: String(error) },
        ),
      ),
      Effect.ignore,
    );
    return {
      recordKills,
      recordTo: (record: Sink["outOfMemory"]) => Ref.set(recorder, Option.some(record)),
      ensureRunning: ensureRunning("cleanup", shell, spec).pipe(
        Effect.tap((state) =>
          state === "running"
            ? Effect.void
            : Effect.andThen(
                Ref.update(starts, (n) => n + 1),
                state === "startedAfterOomKill"
                  ? Ref.update(killedInits, (n) => n + 1)
                  : Effect.void,
              ),
        ),
      ),
    };
  });

  /**
   * Removes the containers labeled with `instance` and `instanceId` on the machine of `shell`
   * whose process label is not in `kept`. Returns the names removed.
   */
  const sweep = Effect.fn("RemoteExecutor.sweepContainers")(function* (
    shell: RemoteHost,
    instance: string,
    instanceId: InstanceId,
    worker: WorkerName,
    kept: ReadonlySet<string>,
    runtime: ContainerRuntime,
  ) {
    yield* Effect.annotateCurrentSpan({ host: shell.destination, worker, instance, instanceId });
    const listed = (yield* commands.run("cleanup", shell, "sh", [
      "-c",
      LIST_SCRIPT,
      "sh",
      runtime,
      `${INSTANCE_LABEL}=${instance}`,
      `${INSTANCE_ID_LABEL}=${instanceId}`,
    ]))
      .split("\n")
      .flatMap((line) => {
        const [name, owner = ""] = line.trim().split(" ");
        return name === undefined || name === "" ? [] : [{ name, owner }];
      });
    const left = listed.filter(({ owner }) => !kept.has(owner)).map(({ name }) => name);
    if (left.length === 0) {
      yield* Effect.logDebug("No earlier process left a container on the Worker's machine", {
        worker,
        host: shell.destination,
        instanceId,
        running: listed.length,
      });
      return left;
    }
    yield* commands.run("cleanup", shell, runtime, ["rm", "--force", "--volumes", ...left]);
    yield* Effect.logInfo("Removed the containers an earlier process left on the machine", {
      worker,
      host: shell.destination,
      instanceId,
      containers: left.join(","),
    });
    return left;
  });

  /** Records that the checkout of `marker` is mounted in a container, before any container starts. */
  const mark = Effect.fn("RemoteExecutor.markContainerCheckout")(function* (
    operation: ExecutorOperation,
    shell: RemoteHost,
    marker: string,
  ) {
    yield* Effect.annotateCurrentSpan({ host: shell.destination, marker });
    yield* commands.run(operation, shell, "sh", ["-c", MARK_SCRIPT, "sh", marker]);
  });

  /** Returns whether a container has had the checkout of `marker` mounted. */
  const marked = Effect.fn("RemoteExecutor.isContainerCheckout")(function* (
    operation: ExecutorOperation,
    shell: RemoteHost,
    marker: string,
  ) {
    yield* Effect.annotateCurrentSpan({ host: shell.destination, marker });
    const inspected = yield* commands.inspect(operation, shell, "test", ["-f", marker]);
    if (inspected.exitCode === 0) return true;
    if (inspected.exitCode === 1) return false;
    return yield* ExecutorOperationError.make({
      operation,
      message: "Can't inspect whether a container had the checkout",
      cause: new Error(inspected.stderr.trim() || `test exited with code ${inspected.exitCode}`),
    });
  });

  return { start, trackMemory, stopChildren, sweep, remove, mark, marked, prepareCaches };
};
