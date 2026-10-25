import { CHILD_KILL_SCRIPT, RemoteShell, type ShellContainer } from "@usine/agents/child-host";
import type { Harness } from "@usine/core/agent/brain";
import type { AttemptId } from "@usine/core/attempt";
import { safeSegment } from "@usine/core/repository";
import type {
  ContainerCpus,
  ContainerImage,
  ContainerMemoryMib,
  ContainerPids,
  WorkerName,
} from "@usine/core/worker";
import { Effect, Option, Redacted } from "effect";
import { type ExecutorOperation, ExecutorOperationError } from "../executor.ts";
import type { RemoteCommands } from "./commands.ts";

/** The container CLI on the machine. */
export const CONTAINER_RUNTIME = "docker";

/** The labels on each container, so a later process finds the ones it left. */
const INSTANCE_LABEL = "dev.usine.instance";
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
  readonly image: ContainerImage;
  readonly cpus: ContainerCpus;
  readonly memoryMib: ContainerMemoryMib;
  readonly pids: ContainerPids;
  /** The value of the instance label, which identifies the containers of this usine instance. */
  readonly instance: string;
}

/** How a Worker runs an Attempt's commands on its machine. */
export type AttemptIsolation =
  /** The SSH user's shell runs every command, so concurrent Attempts can read each other's files and processes. */
  | { readonly _tag: "SharedUser" }
  /** Each Attempt's commands run in its own container; the SSH user's shell runs only the container's lifecycle and the cached clone's fetch. */
  | { readonly _tag: "Container"; readonly settings: ContainerSettings };

export const sharedUser: AttemptIsolation = { _tag: "SharedUser" };

/**
 * The harness login files under the SSH user's home: `mounted` ones at the same path under the
 * container's home, read-write because the harness rewrites them when it refreshes its OAuth
 * token, and `seeded` ones copied there at start.
 */
const LOGIN_FILES = {
  claude: { mounted: [".claude/.credentials.json"], seeded: [".claude.json"] },
  codex: { mounted: [".codex/auth.json"], seeded: [".codex/config.toml"] },
  pi: { mounted: [], seeded: [] },
} as const satisfies Record<
  Harness,
  { readonly mounted: ReadonlyArray<string>; readonly seeded: ReadonlyArray<string> }
>;

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
const STOP_CHILDREN_SCRIPT = String.raw`
if ! state=$("$1" container inspect --format '{{.State.Running}}' "$2" 2>&1); then
  case "$state" in
    *"No such"*) echo no-container; exit 0 ;;
  esac
  printf '%s\n' "$state" >&2
  exit 1
fi
if [ "$state" != true ]; then echo container-stopped; exit 0; fi
exec "$1" exec "$2" sh -c "$3" sh "$4"
`.trim();

/**
 * A script that lists the containers labeled `$2`, one `<name> <worker>` line each. Prints
 * nothing if the machine has no container CLI.
 */
const LIST_SCRIPT = String.raw`
command -v "$1" >/dev/null 2>&1 || exit 0
exec "$1" ps --all --filter "label=$2" --format '{{.Names}} {{.Label "dev.usine.worker"}}'
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
      new ExecutorOperationError({
        operation,
        message: `Can't set ${multiline[0]} in a container: its value has a line break`,
        cause: new Error(`${multiline[0]} has a line break`),
      }),
    );
  return Effect.succeed(
    Redacted.make(entries.map(([name, value]) => `${name}=${value}\n`).join("")),
  );
};

/** Returns the shell that runs commands in the container `name` on the machine of `shell`. */
const containerShell = (shell: RemoteShell, name: string): RemoteShell => {
  const container: ShellContainer = { runtime: CONTAINER_RUNTIME, name };
  return new RemoteShell({
    ssh: shell.ssh,
    sshEnvironment: shell.sshEnvironment,
    destination: shell.destination,
    container,
  });
};

/**
 * Returns the operations on the containers of a machine: start one for an Attempt or a
 * preflight, stop an Attempt's children in it, and remove the containers that an earlier
 * process left.
 */
export const containersFor = (commands: RemoteCommands) => {
  const remove = Effect.fn("RemoteExecutor.removeContainer")(function* (
    shell: RemoteShell,
    name: string,
  ) {
    yield* Effect.annotateCurrentSpan({ host: shell.destination, container: name });
    yield* commands.run("cleanup", shell, CONTAINER_RUNTIME, ["rm", "--force", name]).pipe(
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
    shell: RemoteShell,
    spec: ContainerSpec,
  ) {
    const host = shell.destination;
    const fields = {
      worker: spec.worker,
      host,
      container: spec.name,
      image: spec.settings.image,
      ...Option.match(spec.attemptId, {
        onNone: () => ({}),
        onSome: (attemptId) => ({ attemptId }),
      }),
    };
    yield* Effect.annotateCurrentSpan(fields);
    const logins = spec.harnesses.flatMap((harness) => [
      ...LOGIN_FILES[harness].mounted.map((file) => ({ file, mounted: true })),
      ...LOGIN_FILES[harness].seeded.map((file) => ({ file, mounted: false })),
    ]);
    const [home = "", ...present] = (yield* commands.run(operation, shell, "sh", [
      "-c",
      PREPARE_SCRIPT,
      "sh",
      CONTAINER_RUNTIME,
      spec.name,
      String(spec.readOnly.length),
      ...spec.readOnly,
      ...logins.map(({ file }) => file),
    ])).split("\n");
    if (!home.startsWith("/"))
      return yield* new ExecutorOperationError({
        operation,
        message: "The SSH user's home on the machine isn't an absolute path",
        cause: new Error(home),
      });
    const found = logins.filter(({ file }) => present.includes(file));
    const readOnly = spec.readOnly.filter((path) => present.includes(path));
    const missing = spec.readOnly.filter((path) => !present.includes(path));
    if (missing.length > 0)
      yield* Effect.logWarning("The container doesn't mount these missing machine paths", {
        ...fields,
        missing: missing.join(","),
      });
    const envFile = yield* environmentFile(operation, {
      ...spec.environment,
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
          `${WORKER_LABEL}=${spec.worker}`,
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
      "--detach",
      "--name",
      spec.name,
      ...lifetime.options,
      ...lifetime.labels.flatMap((label) => ["--label", label]),
      "--network",
      "host",
      "--cpus",
      String(spec.settings.cpus),
      "--memory",
      `${spec.settings.memoryMib}m`,
      "--pids-limit",
      String(spec.settings.pids),
      "--env-file",
      "/dev/stdin",
      ...mounts.flatMap((mount) => ["--mount", mount]),
      spec.settings.image,
      ...lifetime.command,
    ];
    yield* Effect.addFinalizer(() => remove(shell, spec.name));
    yield* commands
      .runWithInput(
        operation,
        shell,
        "sh",
        ["-c", PIPED_STDIN_SCRIPT, "sh", CONTAINER_RUNTIME, ...args],
        envFile,
      )
      .pipe(Effect.ensuring(Effect.sync(() => Redacted.wipeUnsafe(envFile))));
    yield* Effect.logInfo("Started the container", {
      ...fields,
      logins: found.map(({ file }) => file).join(","),
      readOnly: readOnly.join(","),
    });
    return containerShell(shell, spec.name);
  });

  /**
   * Stops the children recorded in the container `name` for the checkout `worktree`. Succeeds
   * without stopping anything if the container doesn't exist or doesn't run.
   */
  const stopChildren = Effect.fn("RemoteExecutor.stopContainerChildren")(function* (
    operation: ExecutorOperation,
    shell: RemoteShell,
    name: string,
    worktree: string,
  ) {
    yield* Effect.annotateCurrentSpan({ host: shell.destination, container: name, worktree });
    const outcome = yield* commands.run(operation, shell, "sh", [
      "-c",
      STOP_CHILDREN_SCRIPT,
      "sh",
      CONTAINER_RUNTIME,
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
   * Removes the containers labeled with `instance` on the machine of `shell` whose Worker
   * label is `worker` or not in `kept`. Returns the names removed.
   */
  const sweep = Effect.fn("RemoteExecutor.sweepContainers")(function* (
    shell: RemoteShell,
    instance: string,
    worker: WorkerName,
    kept: ReadonlySet<string>,
  ) {
    yield* Effect.annotateCurrentSpan({ host: shell.destination, worker, instance });
    const listed = (yield* commands.run("cleanup", shell, "sh", [
      "-c",
      LIST_SCRIPT,
      "sh",
      CONTAINER_RUNTIME,
      `${INSTANCE_LABEL}=${instance}`,
    ]))
      .split("\n")
      .flatMap((line) => {
        const [name, owner = ""] = line.trim().split(" ");
        return name === undefined || name === "" ? [] : [{ name, owner }];
      });
    const left = listed
      .filter(({ owner }) => owner === worker || !kept.has(owner))
      .map(({ name }) => name);
    if (left.length === 0) {
      yield* Effect.logDebug("No earlier process left a container on the Worker's machine", {
        worker,
        host: shell.destination,
        running: listed.length,
      });
      return left;
    }
    yield* commands.run("cleanup", shell, CONTAINER_RUNTIME, ["rm", "--force", ...left]);
    yield* Effect.logInfo("Removed the containers an earlier process left on the machine", {
      worker,
      host: shell.destination,
      containers: left.join(","),
    });
    return left;
  });

  /** Records that the checkout of `marker` is mounted in a container, before any container starts. */
  const mark = Effect.fn("RemoteExecutor.markContainerCheckout")(function* (
    operation: ExecutorOperation,
    shell: RemoteShell,
    marker: string,
  ) {
    yield* Effect.annotateCurrentSpan({ host: shell.destination, marker });
    yield* commands.run(operation, shell, "sh", ["-c", MARK_SCRIPT, "sh", marker]);
  });

  /** Returns whether a container has had the checkout of `marker` mounted. */
  const marked = Effect.fn("RemoteExecutor.isContainerCheckout")(function* (
    operation: ExecutorOperation,
    shell: RemoteShell,
    marker: string,
  ) {
    yield* Effect.annotateCurrentSpan({ host: shell.destination, marker });
    const inspected = yield* commands.inspect(operation, shell, "test", ["-f", marker]);
    if (inspected.exitCode === 0) return true;
    if (inspected.exitCode === 1) return false;
    return yield* new ExecutorOperationError({
      operation,
      message: "Can't inspect whether a container had the checkout",
      cause: new Error(inspected.stderr.trim() || `test exited with code ${inspected.exitCode}`),
    });
  });

  return { start, stopChildren, sweep, remove, mark, marked };
};
