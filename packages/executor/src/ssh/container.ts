import { boatTailnetOf } from "./model.ts";
import { SSH_FAILURE } from "@usine/agents/child-host";
import type { Harness } from "@usine/core/agent/brain";
import type { InstanceId } from "@usine/core/instance";
import { safeSegment } from "@usine/core/repository";
import { ContainerImage, type WorkerName } from "@usine/core/worker";
import { Cache, Effect, Option, Random, Ref, Schema } from "effect";
import { type ExecutorError, WorkerCapabilityError } from "../executor.ts";
import { keyedLockFor } from "../keyed-lock.ts";
import type { RemoteCommands } from "../remote/commands.ts";
import {
  type AttemptIsolation,
  CONTAINER_RUNTIME,
  type ContainerSettings,
  containersFor,
  PNPM_STORE_MOUNT,
  PNPM_STORE_PATH,
  PNPM_STORE_VOLUME,
  sharedUser,
} from "../remote/container.ts";
import {
  configuredLimits,
  limitFields,
  RESOURCES_SCRIPT,
  resolveLimits,
  type ResolvedLimits,
  resourcesFromOutput,
} from "./limits.ts";
import type { SshMachine } from "./model.ts";

/**
 * The image of each Attempt container when `usine.yaml` names none, built from
 * `infra/worker-image/Dockerfile` with this release's harness versions.
 */
export const ATTEMPT_IMAGE = ContainerImage.make(
  "ghcr.io/basaltbytes/usine-worker:claude-2.1.308-codex-0.159.2",
);

/** The exit code of `DETECT_SCRIPT` when the machine has no Docker and the SSH user no access to one. */
const RUNTIME_ABSENT = 3;
/** The exit code of `DETECT_SCRIPT` when the SSH user can use Docker's socket but has no `docker` CLI. */
const SOCKET_WITHOUT_CLI = 4;

/**
 * A script that prints the version of the container runtime `$1`'s server. Without the CLI, it
 * exits 4 if the SSH user is in the `docker` group or can write Docker's socket, and 3 if not.
 */
const DETECT_SCRIPT = String.raw`
if ! command -v "$1" >/dev/null 2>&1; then
  for group in $(id -nG); do
    if [ "$group" = docker ]; then exit 4; fi
  done
  if [ -w /var/run/docker.sock ]; then exit 4; fi
  exit 3
fi
exec "$1" version -f '{{.Server.Version}}'
`.trim();

/** A script that prints the SSH user's ID and the ID of image `$2`'s user, separated by a space. */
const USER_IDS_SCRIPT = String.raw`
image_uid=$("$1" run --rm --network none --entrypoint id "$2" -u) || exit 1
printf '%s %s\n' "$(id -u)" "$image_uid"
`.trim();

const decodeStoreSize = Schema.decodeUnknownEffect(
  Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
);

/** What a preflight found about the containers of a Worker. */
type ContainerCheck =
  /** Each Attempt runs in its own container from `settings`. */
  | {
      readonly _tag: "Container";
      readonly settings: ContainerSettings;
      readonly limits: ResolvedLimits;
    }
  /** Attempts run as the SSH user, for the `degraded` reason. */
  | { readonly _tag: "SharedUser"; readonly degraded: string };

const containerGap = (worker: WorkerName, message: string, cause: unknown) =>
  new WorkerCapabilityError({ worker, capability: "container", message, cause });

/**
 * Returns the container operations of the SSH executor: the preflight checks of a Worker's
 * Docker and image, the isolation they found, a container for a preflight's harness probes, and
 * the removal of containers an earlier process left.
 */
export const sshContainersFor = Effect.fn("SshExecutor.containersFor")(function* (
  commands: RemoteCommands,
  machineFor: (worker: WorkerName) => Effect.Effect<SshMachine, ExecutorError>,
  instance: string,
  instanceId: InstanceId,
) {
  const containers = containersFor(commands);
  const preparedCaches = new WeakSet<SshMachine>();
  const cacheLocks = yield* keyedLockFor<WorkerName>();
  const prepareCaches = Effect.fn("SshExecutor.prepareSharedCaches")(
    function* (machine: SshMachine, image: ContainerImage) {
      const fields = { worker: machine.address.name, host: machine.shell.destination, image };
      yield* Effect.annotateCurrentSpan(fields);
      if (preparedCaches.has(machine)) {
        yield* Effect.logDebug("Shared caches already prepared on this machine", fields);
        return;
      }
      yield* containers.prepareCaches("prepare", machine.shell, image, machine.address.name);
      preparedCaches.add(machine);
    },
    (effect, machine) => effect.pipe(cacheLocks.withLock(machine.address.name)),
  );
  const isolations = yield* Ref.make(new Map<WorkerName, AttemptIsolation>());
  // Workers whose earlier containers this process removed. Their containers on a shared machine
  // belong to this process, so another Worker's removal keeps them.
  const reclaimed = yield* Ref.make(new Set<string>());

  const imageFor = (machine: SshMachine): ContainerImage =>
    Option.getOrElse(machine.address.container.image, () => ATTEMPT_IMAGE);

  /** Reads the CPUs, memory, and task limit of the machine's kernel. */
  const readResources = Effect.fn("SshExecutor.readMachineResources")(function* (
    machine: SshMachine,
  ) {
    const worker = machine.address.name;
    const host = machine.shell.destination;
    yield* Effect.annotateCurrentSpan({ worker, host });
    const read = yield* commands.inspect("preflight", machine.shell, "sh", [
      "-c",
      RESOURCES_SCRIPT,
    ]);
    const resources = resourcesFromOutput(read.stdout);
    if (read.exitCode === 0 && Option.isSome(resources)) return resources.value;
    return yield* containerGap(
      worker,
      read.exitCode === SSH_FAILURE
        ? `Can't reach SSH worker "${worker}" at ${host} to read its CPUs and memory`
        : `Can't read the CPUs, memory, and task limit of SSH worker "${worker}" to derive the limits of its containers. Set cpus, memory_mib, and pids under the worker's container in usine.yaml.`,
      new Error(read.stderr.trim() || `exit code ${read.exitCode}`),
    );
  });

  /**
   * Returns the limits of each container on the machine when `slots` Attempts run on it at once:
   * the ones `usine.yaml` sets, and the others derived from the machine. Reads the machine only
   * if a limit is unset.
   */
  const limitsFor = Effect.fn("SshExecutor.containerLimits")(function* (
    machine: SshMachine,
    slots: number,
  ) {
    yield* Effect.annotateCurrentSpan({ worker: machine.address.name, slots });
    const configured = configuredLimits(machine.address.container);
    if (Option.isSome(configured)) return configured.value;
    return resolveLimits(machine.address.container, yield* readResources(machine), slots);
  });

  /**
   * Returns the server version of the machine's Docker, or `None` if the machine has none and
   * the SSH user no access to one. Fails if the SSH user can use Docker but Docker doesn't
   * answer, because Attempts must then run in containers: as the SSH user, they could use
   * Docker's socket to act as root.
   */
  const detect = Effect.fn("SshExecutor.detectContainerRuntime")(function* (machine: SshMachine) {
    const worker = machine.address.name;
    const host = machine.shell.destination;
    yield* Effect.annotateCurrentSpan({ worker, host });
    const detected = yield* commands.inspect("preflight", machine.shell, "sh", [
      "-c",
      DETECT_SCRIPT,
      "sh",
      CONTAINER_RUNTIME,
    ]);
    if (detected.exitCode === RUNTIME_ABSENT) return Option.none<string>();
    const version = detected.stdout.trim();
    if (detected.exitCode === 0 && version !== "") return Option.some(version);
    if (detected.exitCode === SSH_FAILURE)
      return yield* containerGap(
        worker,
        `Can't reach SSH worker "${worker}" at ${host} to check Docker`,
        new Error(detected.stderr.trim() || `ssh exited with code ${SSH_FAILURE}`),
      );
    if (detected.exitCode === SOCKET_WITHOUT_CLI)
      return yield* containerGap(
        worker,
        `The SSH user of worker "${worker}" can use Docker's socket, but the docker CLI isn't installed. Install it, so that each attempt runs in its own container, or take the user out of the docker group.`,
        new Error("docker group or writable socket without the docker CLI"),
      );
    return yield* containerGap(
      worker,
      `Docker on SSH worker "${worker}" doesn't respond to its SSH user. Start Docker, and add the user to the docker group.`,
      new Error(detected.stderr.trim() || `docker version exited with code ${detected.exitCode}`),
    );
  });

  const record = (worker: WorkerName, isolation: AttemptIsolation) =>
    Ref.update(isolations, (current) => new Map(current).set(worker, isolation));

  /**
   * Records that the machine's Worker runs its Attempts as the SSH user, since the machine has no
   * Docker, and logs it.
   */
  const recordSharedUser = (machine: SshMachine) =>
    record(machine.address.name, sharedUser).pipe(
      Effect.andThen(
        Effect.logWarning(
          "SSH Worker has no Docker; its Attempts run as the SSH user and can read each other's credentials",
          { worker: machine.address.name, host: machine.shell.destination },
        ),
      ),
      Effect.as(sharedUser),
    );

  /**
   * Records that each Attempt of the machine's Worker runs in its own container from the image,
   * with the limits for `slots` Attempts on the machine at once, and logs them. `docker` is the
   * server version of the machine's Docker.
   */
  const recordContainer = Effect.fn("SshExecutor.recordContainer")(function* (
    machine: SshMachine,
    docker: string,
    slots: number,
  ) {
    const worker = machine.address.name;
    const image = imageFor(machine);
    yield* Effect.annotateCurrentSpan({ worker, image, slots });
    const limits = yield* limitsFor(machine, slots);
    const hosts = Option.match(Option.all([boatTailnetOf(machine.address), machine.gateway]), {
      onNone: () => ({}),
      onSome: ([tailnet, gateway]) => ({
        [`git.${gateway.settings.domain}`]: tailnet.gatewayAddress,
        [`llm.${gateway.settings.domain}`]: tailnet.gatewayAddress,
      }),
    });
    const settings: ContainerSettings = {
      image,
      limits: limits.limits,
      instance,
      instanceId,
      hosts,
    };
    yield* record(worker, { _tag: "Container", settings });
    yield* Effect.logInfo("SSH Worker runs each Attempt in its own container", {
      worker,
      host: machine.shell.destination,
      docker,
      image,
      ...limitFields(limits),
    });
    return { _tag: "Container", settings, limits } satisfies ContainerCheck;
  });

  /**
   * Checks the machine's Docker for preflight, pulls the Attempt image, checks that the image's
   * user has the SSH user's ID, so the containers can write the checkouts, and finds the limits
   * of each container when `slots` Attempts run on the machine at once. Only a machine without
   * Docker runs Attempts as the SSH user, which the result reports as degraded; with Docker, any
   * failure fails the preflight.
   */
  const verify = Effect.fn("SshExecutor.verifyContainers")(function* (
    machine: SshMachine,
    slots: number,
  ) {
    const worker = machine.address.name;
    const host = machine.shell.destination;
    const image = imageFor(machine);
    yield* Effect.annotateCurrentSpan({ worker, host, image, slots });
    const version = yield* detect(machine);
    if (Option.isNone(version)) {
      yield* recordSharedUser(machine);
      return {
        _tag: "SharedUser",
        degraded:
          "Docker isn't installed, so attempts run as the SSH user and can read each other's credentials. Install Docker to run each attempt in its own container.",
      } satisfies ContainerCheck;
    }
    const pulled = yield* commands.inspect("preflight", machine.shell, CONTAINER_RUNTIME, [
      "pull",
      "--quiet",
      image,
    ]);
    if (pulled.exitCode !== 0) {
      const local = yield* commands.inspect("preflight", machine.shell, CONTAINER_RUNTIME, [
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        image,
      ]);
      if (local.exitCode !== 0)
        return yield* containerGap(
          worker,
          `SSH worker "${worker}" can't pull the attempt image ${image}`,
          new Error(pulled.stderr.trim() || `docker pull exited with code ${pulled.exitCode}`),
        );
      yield* Effect.logWarning(
        "SSH Worker could not pull the Attempt image; its Attempts use the image already on the machine",
        { worker, host, image, message: pulled.stderr.trim() },
      );
    }
    const ids = yield* commands.inspect("preflight", machine.shell, "sh", [
      "-c",
      USER_IDS_SCRIPT,
      "sh",
      CONTAINER_RUNTIME,
      image,
    ]);
    const [hostId, imageId] = ids.stdout.trim().split(" ");
    if (ids.exitCode !== 0 || hostId === undefined || imageId === undefined)
      return yield* containerGap(
        worker,
        `SSH worker "${worker}" can't run the attempt image ${image}`,
        new Error(ids.stderr.trim() || `exit code ${ids.exitCode}`),
      );
    if (hostId !== imageId)
      return yield* containerGap(
        worker,
        `The attempt image ${image} runs as user ID ${imageId}, and the SSH user of worker "${worker}" has ID ${hostId}, so its containers can't write the checkouts. Build the image with --build-arg USINE_UID=${hostId}.`,
        new Error(`user IDs ${hostId} and ${imageId}`),
      );
    yield* containers
      .prepareCaches("preflight", machine.shell, image, worker)
      .pipe(
        Effect.mapError((error) =>
          containerGap(worker, `Can't prepare the shared caches: ${error.message}`, error),
        ),
      );
    preparedCaches.add(machine);
    const size = yield* commands
      .run("preflight", machine.shell, CONTAINER_RUNTIME, [
        "run",
        "--rm",
        "--network",
        "none",
        "--mount",
        PNPM_STORE_MOUNT,
        "--entrypoint",
        "du",
        image,
        "-sk",
        PNPM_STORE_PATH,
      ])
      .pipe(
        Effect.flatMap((output) => decodeStoreSize(output.trim().split(/\s+/u)[0])),
        Effect.mapError((error) =>
          containerGap(worker, `Can't measure the shared pnpm store on worker "${worker}"`, error),
        ),
      );
    yield* Effect.logInfo("Shared pnpm store disk usage", {
      worker,
      host,
      volume: PNPM_STORE_VOLUME,
      sizeKiB: size,
    });
    return yield* recordContainer(machine, version.value, slots);
  });

  /**
   * Returns how new Attempts on the machine run, as the Worker's last preflight found, or detects
   * and logs it. Before any preflight on the Worker, as for the recovery of a provisioned Worker's
   * machine, it derives the unset limits for one Attempt on the machine.
   */
  const isolationOf = Effect.fn("SshExecutor.isolation")(function* (machine: SshMachine) {
    const recorded = (yield* Ref.get(isolations)).get(machine.address.name);
    if (recorded !== undefined) {
      if (recorded._tag === "Container") yield* prepareCaches(machine, recorded.settings.image);
      return recorded;
    }
    const version = yield* detect(machine);
    if (Option.isNone(version)) return yield* recordSharedUser(machine);
    yield* prepareCaches(machine, imageFor(machine));
    const { settings } = yield* recordContainer(machine, version.value, 1);
    return { _tag: "Container", settings } satisfies AttemptIsolation;
  });

  /**
   * Starts a container from `settings` for a preflight's harness probes, with the login files
   * of `harnesses` and `environment`, until the caller's scope closes. It removes itself after
   * 15 minutes if this process can't.
   */
  const preflightShell = Effect.fn("SshExecutor.preflightContainer")(function* (
    machine: SshMachine,
    settings: ContainerSettings,
    harnesses: ReadonlyArray<Harness>,
    environment: Readonly<Record<string, string>>,
  ) {
    const suffix = yield* Random.nextIntBetween(0, 1_000_000_000);
    return yield* containers.start("preflight", machine.shell, {
      name: `usine-preflight-${safeSegment(machine.address.name)}-${suffix}`,
      settings,
      worker: machine.address.name,
      attemptId: Option.none(),
      checkout: Option.none(),
      readOnly: [],
      writable: [],
      harnesses,
      environment,
      secrets: {},
    });
  });

  const sweep = Effect.fn("SshExecutor.removeLeftContainers")(function* (worker: WorkerName) {
    const machine = yield* machineFor(worker);
    yield* Effect.annotateCurrentSpan({ worker, host: machine.shell.destination });
    yield* Ref.update(reclaimed, (current) => new Set(current).add(worker));
    yield* containers.sweep(machine.shell, instance, instanceId, worker, yield* Ref.get(reclaimed));
  });
  // Runs once per Worker in this process, before its first container starts. A failure is
  // logged; the containers stay until the next process.
  const swept = yield* Cache.make({
    capacity: Number.POSITIVE_INFINITY,
    lookup: (worker: WorkerName) =>
      sweep(worker).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Could not remove the containers an earlier process left", {
            worker,
            message: error.message,
          }),
        ),
        Effect.ignore,
      ),
  });

  return {
    verify,
    isolation: isolationOf,
    preflightShell,
    reclaim: (worker: WorkerName) => Cache.get(swept, worker),
  };
});

export type SshContainers = Effect.Success<ReturnType<typeof sshContainersFor>>;
