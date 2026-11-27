import type { HarnessCatalog } from "@usine/agents/harness";
import type { RemoteHost } from "@usine/agents/child-host";
import type { BrainSpec, Harness } from "@usine/core/agent/brain";
import type { WorkerName } from "@usine/core/worker";
import { Array as Arr, Effect, Match, Option } from "effect";
import {
  type ExecutorError,
  logPreflightFailure,
  type PreflightImage,
  type PreflightReport,
  WorkerCapabilityError,
  type WorkerCapability,
} from "../executor.ts";
import { type HarnessProbe, verifyHarnessReadiness } from "../harness-preflight.ts";
import { verifyLinuxMemory } from "../memory-preflight.ts";
import type { RemoteCommands } from "../remote/commands.ts";
import { loginFiles } from "../remote/container.ts";
import type { MachineCredentialRoute } from "../remote/machine.ts";
import { verifyKernelLog } from "../remote/memory.ts";
import { classifyDiskFull } from "../disk-full.ts";
import { machineCredentialRoute } from "./api-keys.ts";
import type { SshContainers } from "./container.ts";
import { verifyFreeDisk } from "./disk.ts";
import { gatewayExportedEnvironment } from "./gateway/environment.ts";
import { verifyGateway } from "./gateway/preflight.ts";
import { configureTailnetGateway } from "./gateway/tailnet.ts";
import { HOST_MEMORY_RESERVE_MIB, limitFields } from "./limits.ts";
import type { SshMachine } from "./model.ts";
import type { SshWorkerEntry } from "./workers.ts";

/** A script that succeeds if `$1` is a directory the SSH user can write to. */
const WRITABLE_DIRECTORY_SCRIPT = 'test -d "$1" && test -w "$1"';

const capabilityError = (
  worker: WorkerName,
  capability: WorkerCapability,
  message: string,
  cause: unknown,
): WorkerCapabilityError => WorkerCapabilityError.make({ worker, capability, message, cause });

/** Why an Attempt's container mounts a harness's login files for each credential route, or doesn't. */
const LOGIN_MOUNT_REASONS = {
  "host-login": "The harness uses the SSH user's login on the machine",
  gateway: "The Gateway holds the credential of the model's provider",
  "api-key": "Each Attempt gets the provisioner's API key for the model's provider",
} as const satisfies Record<MachineCredentialRoute, string>;

/**
 * Returns the harnesses whose login files the containers on the machine mount: those with a brain
 * in `brains` that uses the SSH user's login. Logs, for each brain, the files that a container
 * mounts if the machine has them, and why.
 */
const containerLogins = Effect.fn("SshExecutor.containerLogins")(function* (
  catalog: HarnessCatalog,
  machine: SshMachine,
  brains: ReadonlyArray<BrainSpec>,
) {
  const worker = machine.address.name;
  yield* Effect.annotateCurrentSpan({
    worker,
    harnesses: Arr.dedupe(brains.map(({ harness }) => harness)).join(","),
  });
  const logins: Array<Harness> = [];
  for (const brain of brains) {
    const harness = brain.harness;
    const credentialRoute = machineCredentialRoute(catalog, machine, brain);
    const files = credentialRoute === "host-login" ? loginFiles(harness) : [];
    yield* Effect.logInfo(
      "Chose the login files that the Worker's containers mount if the machine has them",
      {
        worker,
        host: machine.shell.destination,
        harness,
        model: brain.model,
        credentialRoute,
        mounted: files.flatMap(({ file, mounted }) => (mounted ? [file] : [])).join(","),
        seeded: files.flatMap(({ file, mounted }) => (mounted ? [] : [file])).join(","),
        reason: LOGIN_MOUNT_REASONS[credentialRoute],
      },
    );
    if (files.length > 0 && !logins.includes(harness)) logins.push(harness);
  }
  return logins;
});

/**
 * Verifies an SSH Worker's machine: SSH connects, the root is a writable directory, Git runs,
 * memory is enough for the concurrent Attempts, the Gateway (if any) responds and is reachable,
 * the container runtime and attempt image work when installed, the root and the image storage
 * have the free disk space of the Worker's threshold, and each brain is ready. With `image`
 * `pull`, the default, pulls the Attempt image and removes older images of its repository. With
 * `defer`, a machine without the image skips the checks that run the image, and the report gives
 * the image as `missingImage` and the brains as deferred. For a fixed tailnet worker, configures
 * gateway routing with passwordless sudo. With a container runtime, it derives the container limits that `usine.yaml` leaves unset
 * for `maxConcurrentAttempts` containers, which the report gives, and
 * brains are probed in a container from the image; without, as the SSH user, which the report
 * gives as degraded. With a container runtime, the report gives as a finding a kernel log that
 * the SSH user can't read. Each runtime synchronizes its login checks.
 */
export const sshMachinePreflightFor = (
  catalog: HarnessCatalog,
  commands: RemoteCommands,
  harnessProbe: (machine: SshMachine, shell: RemoteHost) => HarnessProbe,
  containers: SshContainers,
) =>
  Effect.fn("SshExecutor.verifyMachine")(function* (
    machine: SshMachine,
    brains: ReadonlyArray<BrainSpec>,
    maxConcurrentAttempts: number,
    image: PreflightImage = "pull",
  ) {
    const worker = machine.address.name;
    const host = machine.shell.destination;
    const root = machine.address.root;
    yield* Effect.annotateCurrentSpan({ worker, host, maxConcurrentAttempts, image });
    const connected = yield* commands
      .inspect("preflight", machine.shell, "true", [])
      .pipe(
        Effect.mapError((cause) =>
          capabilityError(
            worker,
            "machine",
            `Can't connect to SSH worker "${worker}" at ${host}`,
            cause,
          ),
        ),
      );
    if (connected.exitCode !== 0)
      return yield* capabilityError(
        worker,
        "machine",
        `Can't connect to SSH worker "${worker}" at ${host}`,
        new Error(
          connected.stderr.trim() || `the command exited with code ${String(connected.exitCode)}`,
        ),
      );
    const rootChecked = yield* commands
      .inspect("preflight", machine.shell, "sh", ["-c", WRITABLE_DIRECTORY_SCRIPT, "sh", root])
      .pipe(
        Effect.mapError((cause) =>
          capabilityError(worker, "machine", `Can't inspect ${root} on ${host}`, cause),
        ),
      );
    if (rootChecked.exitCode !== 0)
      return yield* capabilityError(
        worker,
        "machine",
        `The root ${root} of SSH worker "${worker}" isn't a writable directory on ${host}`,
        new Error(rootChecked.stderr.trim() || `exit code ${String(rootChecked.exitCode)}`),
      );
    const gitVersion = (yield* commands
      .run("preflight", machine.shell, "git", ["--version"])
      .pipe(
        Effect.mapError((cause) =>
          capabilityError(worker, "toolchain", `Worker "${worker}" can't run Git`, cause),
        ),
      )).trim();
    if (!gitVersion.startsWith("git version "))
      return yield* capabilityError(
        worker,
        "toolchain",
        `Worker "${worker}" returned an unrecognized Git version`,
        new Error(gitVersion),
      );
    const memory = yield* verifyLinuxMemory(
      worker,
      maxConcurrentAttempts,
      commands.run("preflight", machine.shell, "cat", ["/proc/meminfo"]),
    );

    let gatewayUpgrade = Option.none<string>();
    if (Option.isSome(machine.gateway)) {
      const address = machine.address.machine;
      if (address._tag === "Fixed" && Option.isSome(address.tailnet))
        yield* configureTailnetGateway(
          commands,
          "preflight",
          machine,
          address.tailnet.value,
          machine.gateway.value.settings.domain,
        );
      gatewayUpgrade = yield* verifyGateway(
        catalog,
        commands,
        worker,
        machine,
        machine.gateway.value,
      );
    }
    const containerCheck = yield* containers.verify(machine, maxConcurrentAttempts, image);
    yield* verifyFreeDisk(
      commands,
      machine,
      containerCheck._tag === "Container"
        ? Option.some(containerCheck.settings.runtime)
        : Option.none(),
      "preflight",
    );
    // Only containers record out-of-memory kills, so only they need the kernel log.
    const findings =
      containerCheck._tag === "Container"
        ? yield* verifyKernelLog(commands, machine.shell).pipe(Effect.map(Option.toArray))
        : [];
    if (containerCheck._tag === "Container") {
      const memoryMib = containerCheck.limits.limits.memoryMib;
      const hostMemoryMib = Math.floor(memory.totalBytes / 1024 ** 2);
      const allocatedMemoryMib = maxConcurrentAttempts * memoryMib;
      const availableMemoryMib = Math.max(0, hostMemoryMib - HOST_MEMORY_RESERVE_MIB);
      if (allocatedMemoryMib > availableMemoryMib)
        yield* Effect.logWarning(
          "Concurrent container memory exceeds the host memory available after its reserve. Reduce max_concurrent_attempts or container.memory_mib.",
          {
            worker,
            host,
            maxConcurrentAttempts,
            memoryMib,
            allocatedMemoryMib,
            hostMemoryMib,
            availableMemoryMib,
            hostReserveMib: HOST_MEMORY_RESERVE_MIB,
          },
        );
      else
        yield* Effect.logInfo("Concurrent container memory fits the host", {
          worker,
          maxConcurrentAttempts,
          allocatedMemoryMib,
          availableMemoryMib,
        });
    }
    const harnesses = Arr.dedupe(brains.map(({ harness }) => harness));
    const probe = (shell: RemoteHost) =>
      verifyHarnessReadiness(worker, machine.provisioned, brains, harnessProbe(machine, shell));
    yield* Match.valueTags(containerCheck, {
      Container: ({ settings, image: attemptImage }) =>
        attemptImage === "missing"
          ? Effect.logInfo(
              "The worker doesn't have the attempt image, so the preflight that pulls it checks the harnesses",
              { worker, host, harnesses: harnesses.join(",") },
            )
          : Effect.scoped(
              containerLogins(catalog, machine, brains).pipe(
                Effect.flatMap((logins) =>
                  containers.preflightShell(
                    machine,
                    settings,
                    logins,
                    Option.match(machine.gateway, {
                      onNone: () => ({}),
                      onSome: (gateway) =>
                        gatewayExportedEnvironment(
                          { ...gateway.settings, catalog },
                          `${machine.workerDirectory}/gh`,
                        ),
                    }),
                  ),
                ),
                Effect.flatMap(probe),
              ),
            ),
      SharedUser: () => probe(machine.shell),
    });
    const fields = {
      worker,
      host,
      root,
      gitVersion,
      isolation: containerCheck._tag,
      harnesses: harnesses.join(","),
      findings: findings.length,
    };
    return yield* Match.valueTags(containerCheck, {
      Container: ({ settings, limits, image: attemptImage }) =>
        Effect.as(
          Effect.logInfo(
            attemptImage === "missing"
              ? "SSH Worker preflight verified without the attempt image"
              : "SSH Worker preflight verified",
            { ...fields, ...limitFields(limits) },
          ),
          {
            degraded: Option.none(),
            deferred:
              attemptImage === "missing"
                ? Option.some("Checked by the preflight that pulls the attempt image.")
                : Option.none(),
            missingImage: attemptImage === "missing" ? Option.some(settings.image) : Option.none(),
            containerLimits: Option.some(limits.limits),
            findings,
            gatewayUpgrade,
          } satisfies PreflightReport,
        ),
      SharedUser: ({ degraded }) =>
        Effect.as(Effect.logInfo("SSH Worker preflight verified", fields), {
          degraded: Option.some(degraded),
          deferred: Option.none(),
          missingImage: Option.none(),
          containerLimits: Option.none(),
          findings,
          gatewayUpgrade,
        } satisfies PreflightReport),
    });
  });

/**
 * Verifies an SSH Worker: a long-lived Worker's machine with `verifyMachine`, or a provisioned
 * Worker with `verifyProvisioned`, which has no machine before an Attempt.
 */
export const sshPreflightFor = (
  workerFor: (worker: WorkerName) => Effect.Effect<SshWorkerEntry, ExecutorError>,
  verifyMachine: ReturnType<typeof sshMachinePreflightFor>,
  verifyProvisioned: (
    entry: SshWorkerEntry,
    brains: ReadonlyArray<BrainSpec>,
    maxConcurrentAttempts: number,
  ) => Effect.Effect<PreflightReport, ExecutorError>,
) =>
  Effect.fn("SshExecutor.preflight")(
    function* (
      worker: WorkerName,
      brains: ReadonlyArray<BrainSpec>,
      maxConcurrentAttempts: number,
      image: PreflightImage = "pull",
    ) {
      yield* Effect.annotateCurrentSpan({ worker, maxConcurrentAttempts, image });
      const entry = yield* workerFor(worker);
      // A provisioned Worker has no machine, so its preflight pulls no image.
      return yield* Option.match(entry.machine, {
        onNone: () => verifyProvisioned(entry, brains, maxConcurrentAttempts),
        onSome: (machine) => verifyMachine(machine, brains, maxConcurrentAttempts, image),
      });
    },
    (effect, worker) => classifyDiskFull(worker, effect),
    logPreflightFailure,
  );
