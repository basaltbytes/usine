import type { RemoteShell } from "@usine/agents/child-host";
import type { ClaudeLoginLock } from "@usine/agents/runtime";
import type { BrainSpec } from "@usine/core/agent/brain";
import type { WorkerName } from "@usine/core/worker";
import { Array as Arr, Effect, Option } from "effect";
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
import type { SshMachine } from "./model.ts";

/** A script that succeeds if `$1` is a directory the SSH user can write to. */
const WRITABLE_DIRECTORY_SCRIPT = 'test -d "$1" && test -w "$1"';

const capabilityError = (
  worker: WorkerName,
  capability: WorkerCapability,
  message: string,
  cause: unknown,
): WorkerCapabilityError => new WorkerCapabilityError({ worker, capability, message, cause });

/**
 * Verifies an SSH Worker: SSH connects, the root is a writable directory, Git runs, memory is
 * enough for the concurrent Attempts, the Gateway (if any) responds and is reachable, Docker
 * and the Attempt image work if the machine has Docker, and each brain is ready. Pulls the
 * Attempt image and changes nothing else. With Docker, brains are probed in a container from
 * the image; without, as the SSH user, which the report gives as degraded. Claude brains are
 * checked under the Worker's lock in `logins`.
 */
export const sshPreflightFor = (
  commands: RemoteCommands,
  machineFor: (worker: WorkerName) => Effect.Effect<SshMachine, ExecutorError>,
  harnessProbe: (machine: SshMachine, shell: RemoteShell) => HarnessProbe,
  logins: ClaudeLoginLock["Service"],
  containers: SshContainers,
) =>
  Effect.fn("SshExecutor.preflight")(function* (
    worker: WorkerName,
    brains: ReadonlyArray<BrainSpec>,
    maxConcurrentAttempts: number,
  ) {
    const machine = yield* machineFor(worker);
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
    const containerCheck = yield* containers.verify(machine);
    const harnesses = Arr.dedupe(brains.map(({ harness }) => harness));
    const probe = (shell: RemoteShell) =>
      verifyHarnessReadiness(worker, brains, harnessProbe(machine, shell), logins);
    yield* containerCheck.isolation._tag === "Container" && harnesses.length > 0
      ? Effect.scoped(
          containers
            .preflightShell(
              machine,
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
    yield* Effect.logInfo("SSH Worker preflight verified", {
      worker,
      host,
      root,
      gitVersion,
      isolation: containerCheck.isolation._tag,
      harnesses: harnesses.join(","),
    });
    return { degraded: containerCheck.degraded } satisfies PreflightReport;
  }, logPreflightFailure);
