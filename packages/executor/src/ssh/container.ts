import { prepareAttemptImage } from "./image.ts";
import { reclaimOnceFor } from "../remote/reclaim.ts";
import { detectRuntime, verifyPodmanLimits } from "./runtime.ts";
import { type ContainerRuntime, runtimeOptions } from "../remote/runtime.ts";
import { boatTailnetOf } from "./model.ts";
import { SSH_FAILURE } from "@usine/agents/child-host";
import type { Harness } from "@usine/core/agent/brain";
import type { InstanceId } from "@usine/core/instance";
import { safeSegment } from "@usine/core/repository";
import { ContainerImage, ContainerScratchMib, type WorkerName } from "@usine/core/worker";
import { Duration, Effect, Option, Random, Schema } from "effect";
import { WorkerCapabilityError } from "../executor.ts";
import { keyedLockFor } from "../keyed-lock.ts";
import type { RemoteCommands } from "../remote/commands.ts";
import {
  type AttemptIsolation,
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
import type { SshMachine, SshWorkerAddress } from "./model.ts";

/**
 * The image of each Attempt container when `usine.yaml` names none, built from
 * `infra/worker-image/Dockerfile` with this release's harness versions.
 */
export const ATTEMPT_IMAGE = ContainerImage.make(
  "ghcr.io/basaltbytes/usine-worker:claude-2.1.311-codex-0.164.0",
);

/** Prints the host UID/GID and image UID/GID, separated by spaces. */
const USER_IDS_SCRIPT = String.raw`
set -eu
runtime=$1
image=$2
set --
if [ "$runtime" = podman ]; then
  image_user=$(podman image inspect --format '{{.Config.User}}' "$image")
  [ -n "$image_user" ] || { echo 'The attempt image must declare its non-root user' >&2; exit 1; }
  set -- --userns=keep-id --cgroupns=private --http-proxy=false --user "$image_user"
fi
image_ids=$("$runtime" run --rm --network none "$@" --entrypoint sh "$image" -ec 'printf "%s %s" "$(id -u)" "$(id -g)"')
printf '%s %s %s\n' "$(id -u)" "$(id -g)" "$image_ids"
`.trim();

const UnixId = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const decodeUserIds = Schema.decodeUnknownEffect(Schema.Tuple([UnixId, UnixId, UnixId, UnixId]));

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
 * container runtime and image, the isolation they found, a container for a preflight's harness probes, and
 * the removal of containers an earlier process left.
 */
export const sshContainersFor = Effect.fn("SshExecutor.containersFor")(function* (
  commands: RemoteCommands,
  instance: string,
  instanceId: InstanceId,
) {
  const containers = containersFor(commands);
  const preparedCaches = new WeakSet<SshMachine>();
  const cacheLocks = yield* keyedLockFor<WorkerName>();
  const prepareCaches = Effect.fn("SshExecutor.prepareSharedCaches")(
    function* (machine: SshMachine, image: ContainerImage, runtime: ContainerRuntime) {
      const fields = {
        worker: machine.address.name,
        host: machine.shell.destination,
        image,
        runtime,
      };
      yield* Effect.annotateCurrentSpan(fields);
      if (preparedCaches.has(machine)) {
        yield* Effect.logDebug("Shared caches already prepared on this machine", fields);
        return;
      }
      const detected = yield* detectRuntime(commands, machine);
      if (Option.isNone(detected) || detected.value !== runtime)
        return yield* containerGap(
          machine.address.name,
          "The machine's container runtime differs from its last preflight. Run preflight before starting attempts.",
          new Error("container runtime changed"),
        );
      yield* prepareAttemptImage(commands, machine, image, runtime, "prepare");
      yield* containers.prepareCaches(
        "prepare",
        machine.shell,
        image,
        machine.address.name,
        runtime,
      );
      preparedCaches.add(machine);
    },
    (effect, machine) => effect.pipe(cacheLocks.withLock(machine.address.name)),
  );
  const isolations = new WeakMap<SshWorkerAddress, AttemptIsolation>();
  const process = `${yield* Random.nextInt}:${yield* Random.nextInt}`;

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

  const record = (machine: SshMachine, isolation: AttemptIsolation) =>
    Effect.sync(() => {
      isolations.set(machine.address, isolation);
    });

  /**
   * Records that the machine's Worker runs its Attempts as the SSH user, since the machine has no
   * container runtime, and logs it.
   */
  const recordSharedUser = (machine: SshMachine) =>
    record(machine, sharedUser).pipe(
      Effect.andThen(
        Effect.logWarning(
          "SSH Worker has no Docker or Podman; its Attempts run as the SSH user and can read each other's credentials",
          { worker: machine.address.name, host: machine.shell.destination },
        ),
      ),
      Effect.as(sharedUser),
    );

  /**
   * Records that each Attempt of the machine's Worker runs in its own container from the image,
   * with the limits for `slots` Attempts on the machine at once, and logs the selected runtime.
   */
  const recordContainer = Effect.fn("SshExecutor.recordContainer")(function* (
    machine: SshMachine,
    runtime: ContainerRuntime,
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
      process,
      image,
      runtime,
      limits: limits.limits,
      shmSizeMib: ContainerScratchMib.make(
        Math.min(
          Option.getOrElse(machine.address.container.shmSizeMib, () => 2048),
          limits.limits.memoryMib,
        ),
      ),
      tmpfsSizeMib: ContainerScratchMib.make(
        Math.min(
          Option.getOrElse(machine.address.container.tmpfsSizeMib, () => 2048),
          limits.limits.memoryMib,
        ),
      ),
      instance,
      instanceId,
      hosts,
    };
    yield* record(machine, { _tag: "Container", settings });
    yield* Effect.logInfo("SSH Worker runs each Attempt in its own container", {
      worker,
      host: machine.shell.destination,
      runtime,
      image,
      ...limitFields(limits),
      shmSizeMib: settings.shmSizeMib,
      tmpfsSizeMib: settings.tmpfsSizeMib,
    });
    return { _tag: "Container", settings, limits } satisfies ContainerCheck;
  });

  /**
   * Checks the machine's runtime for preflight, pulls the Attempt image, checks that the image's
   * user has the SSH user's ID, so the containers can write the checkouts, and finds the limits
   * of each container when `slots` Attempts run on the machine at once. Only a machine without
   * runtime runs attempts as the SSH user, which the result reports as degraded; with a runtime, any
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
    const selected = yield* detectRuntime(commands, machine);
    if (Option.isNone(selected)) {
      yield* recordSharedUser(machine);
      return {
        _tag: "SharedUser",
        degraded:
          "Neither Podman nor Docker is installed, so attempts run as the SSH user and can read each other's credentials. Install rootless Podman or Docker to run each attempt in its own container.",
      } satisfies ContainerCheck;
    }
    yield* prepareAttemptImage(commands, machine, image, selected.value, "preflight");
    const [probeDuration, ids] = yield* commands
      .inspect("preflight", machine.shell, "sh", [
        "-c",
        USER_IDS_SCRIPT,
        "sh",
        selected.value,
        image,
      ])
      .pipe(Effect.timed);
    yield* Effect.logInfo("Ran the attempt image user probe", {
      worker,
      host,
      image,
      runtime: selected.value,
      durationMillis: Duration.toMillis(probeDuration),
      exitCode: ids.exitCode,
    });
    if (ids.exitCode !== 0)
      return yield* containerGap(
        worker,
        `SSH worker "${worker}" can't run the attempt image ${image}`,
        new Error(ids.stderr.trim() || `exit code ${ids.exitCode}`),
      );
    const [hostId, hostGid, imageId, imageGid] = yield* decodeUserIds(
      ids.stdout.trim().split(/\s+/u),
    ).pipe(
      Effect.mapError((cause) =>
        containerGap(worker, "The image user probe returned invalid UID/GID values", cause),
      ),
    );
    if (hostId !== imageId || hostGid !== imageGid)
      return yield* containerGap(
        worker,
        `The attempt image ${image} runs as user ID ${imageId} and group ID ${imageGid}, and the SSH user of worker "${worker}" has ID ${hostId} and group ID ${hostGid}, so its containers can't write the checkouts. Build the image with --build-arg USINE_UID=${hostId}.`,
        new Error(`user IDs ${hostId} and ${imageId}`),
      );
    yield* containers
      .prepareCaches("preflight", machine.shell, image, worker, selected.value)
      .pipe(
        Effect.mapError((error) =>
          containerGap(worker, `Can't prepare the shared caches: ${error.message}`, error),
        ),
      );
    preparedCaches.add(machine);
    const size = yield* commands
      .run("preflight", machine.shell, selected.value, [
        "run",
        ...runtimeOptions(selected.value),
        "--rm",
        "--network",
        "none",
        "--volume",
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
    return yield* recordContainer(machine, selected.value, slots);
  });

  /**
   * Returns the isolation from the last preflight for this connection configuration, or detects
   * and logs it. Without a preflight, it derives unset limits using the original slot count
   * for a fixed machine, or one slot for a provisioned machine.
   */
  const isolationOf = Effect.fn("SshExecutor.isolation")(function* (machine: SshMachine) {
    const recorded = isolations.get(machine.address);
    const fields = { worker: machine.address.name, host: machine.shell.destination };
    yield* Effect.annotateCurrentSpan(fields);
    if (recorded !== undefined) {
      yield* Effect.logDebug("Using the SSH connection's checked attempt isolation", {
        ...fields,
        isolation: recorded._tag,
      });
      if (recorded._tag === "Container")
        yield* prepareCaches(machine, recorded.settings.image, recorded.settings.runtime);
      return recorded;
    }
    const selected = yield* detectRuntime(commands, machine);
    if (Option.isNone(selected)) return yield* recordSharedUser(machine);
    yield* prepareCaches(machine, imageFor(machine), selected.value);
    const { settings } = yield* recordContainer(
      machine,
      selected.value,
      Option.isSome(machine.provisioned) ? 1 : (machine.address.maxConcurrentAttempts ?? 1),
    );
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
    const shell = yield* containers.start("preflight", machine.shell, {
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
    if (settings.runtime === "podman")
      yield* verifyPodmanLimits(commands, shell, machine.address.name, settings.limits);
    return shell;
  });

  const sweep = Effect.fn("SshExecutor.removeLeftContainers")(function* (machine: SshMachine) {
    const worker = machine.address.name;
    yield* Effect.annotateCurrentSpan({ worker, host: machine.shell.destination });
    const runtime = yield* detectRuntime(commands, machine);
    if (Option.isSome(runtime))
      yield* containers.sweep(
        machine.shell,
        instance,
        instanceId,
        worker,
        new Set([process]),
        runtime.value,
      );
  });
  // Runs once per destination and worker, before its first container starts. A failure is
  // cached and propagated; the containers and connection records stay until the next process.
  const reclaim = yield* reclaimOnceFor(
    (machine: SshMachine) => `${machine.shell.destination} ${machine.address.name}`,
    (machine) =>
      sweep(machine).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Could not remove containers an earlier process left", {
            worker: machine.address.name,
            message: error.message,
          }),
        ),
      ),
  );

  return {
    verify,
    isolation: isolationOf,
    preflightShell,
    reclaim,
  };
});

export type SshContainers = Effect.Success<ReturnType<typeof sshContainersFor>>;
