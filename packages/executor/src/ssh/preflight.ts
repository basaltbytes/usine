import type { RemoteShell } from "@usine/agents/child-host";
import type { ClaudeLoginLock } from "@usine/agents/runtime";
import type { BrainSpec } from "@usine/core/agent/brain";
import type { WorkerName } from "@usine/core/worker";
import { Array as Arr, Effect, Match, Option } from "effect";
import {
  type ExecutorError,
  logPreflightFailure,
  type PreflightReport,
  WorkerCapabilityError,
  type WorkerCapability,
} from "../executor.ts";
import { type HarnessProbe, verifyHarnessReadiness } from "../harness-preflight.ts";
import { verifyLinuxMemory } from "../memory-preflight.ts";
import type { RemoteCommands } from "../remote/commands.ts";
import type { SshContainers } from "./container.ts";
import { gatewayExportedEnvironment } from "./gateway/environment.ts";
import { verifyGateway } from "./gateway/preflight.ts";
import { limitFields } from "./limits.ts";
import type { SshMachine } from "./model.ts";
import type { SshWorkerEntry } from "./workers.ts";

/** A script that succeeds if `$1` is a directory the SSH user can write to. */
const WRITABLE_DIRECTORY_SCRIPT = 'test -d "$1" && test -w "$1"';

const capabilityError = (
  worker: WorkerName,
  capability: WorkerCapability,
  message: string,
  cause: unknown,
): WorkerCapabilityError => new WorkerCapabilityError({ worker, capability, message, cause });

/**
 * Verifies an SSH Worker's machine: SSH connects, the root is a writable directory, Git runs,
 * memory is enough for the concurrent Attempts, the Gateway (if any) responds and is reachable,
 * Docker and the Attempt image work if the machine has Docker, and each brain is ready. Pulls
 * the Attempt image and changes nothing else. With Docker, it derives the container limits that
 * `usine.yaml` leaves unset for `maxConcurrentAttempts` containers, which the report gives, and
 * brains are probed in a container from the image; without, as the SSH user, which the report
 * gives as degraded. Claude brains are checked under the Worker's lock in `logins`.
 */
export const sshMachinePreflightFor = (
  commands: RemoteCommands,
  harnessProbe: (machine: SshMachine, shell: RemoteShell) => HarnessProbe,
  logins: ClaudeLoginLock["Service"],
  containers: SshContainers,
) =>
  Effect.fn("SshExecutor.verifyMachine")(function* (
    machine: SshMachine,
    brains: ReadonlyArray<BrainSpec>,
    maxConcurrentAttempts: number,
  ) {
    const worker = machine.address.name;
    const host = machine.shell.destination;
    const root = machine.address.root;
    yield* Effect.annotateCurrentSpan({ worker, host, maxConcurrentAttempts });
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
        new Error(connected.stderr.trim() || `ssh exited with code ${String(connected.exitCode)}`),
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
    yield* verifyLinuxMemory(
      worker,
      maxConcurrentAttempts,
      commands.run("preflight", machine.shell, "cat", ["/proc/meminfo"]),
    );

    if (Option.isSome(machine.gateway))
      yield* verifyGateway(commands, worker, machine, machine.gateway.value);
    const containerCheck = yield* containers.verify(machine, maxConcurrentAttempts);
    const harnesses = Arr.dedupe(brains.map(({ harness }) => harness));
    const probe = (shell: RemoteShell) =>
      verifyHarnessReadiness(
        worker,
        machine.provisioned,
        brains,
        harnessProbe(machine, shell),
        logins,
      );
    yield* containerCheck._tag === "Container" && harnesses.length > 0
      ? Effect.scoped(
          containers
            .preflightShell(
              machine,
              containerCheck.settings,
              harnesses,
              Option.match(machine.gateway, {
                onNone: () => ({}),
                onSome: ({ settings }) =>
                  gatewayExportedEnvironment(settings, `${machine.workerDirectory}/gh`),
              }),
            )
            .pipe(Effect.flatMap(probe)),
        )
      : probe(machine.shell);
    const fields = {
      worker,
      host,
      root,
      gitVersion,
      isolation: containerCheck._tag,
      harnesses: harnesses.join(","),
    };
    return yield* Match.valueTags(containerCheck, {
      Container: ({ limits }) =>
        Effect.as(
          Effect.logInfo("SSH Worker preflight verified", { ...fields, ...limitFields(limits) }),
          {
            degraded: Option.none(),
            deferred: Option.none(),
            containerLimits: Option.some(limits.limits),
          } satisfies PreflightReport,
        ),
      SharedUser: ({ degraded }) =>
        Effect.as(Effect.logInfo("SSH Worker preflight verified", fields), {
          degraded: Option.some(degraded),
          deferred: Option.none(),
          containerLimits: Option.none(),
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
  Effect.fn("SshExecutor.preflight")(function* (
    worker: WorkerName,
    brains: ReadonlyArray<BrainSpec>,
    maxConcurrentAttempts: number,
  ) {
    yield* Effect.annotateCurrentSpan({ worker, maxConcurrentAttempts });
    const entry = yield* workerFor(worker);
    return yield* Option.match(entry.machine, {
      onNone: () => verifyProvisioned(entry, brains, maxConcurrentAttempts),
      onSome: (machine) => verifyMachine(machine, brains, maxConcurrentAttempts),
    });
  }, logPreflightFailure);
