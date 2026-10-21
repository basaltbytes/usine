import type { ClaudeLoginLock } from "@usine/agents/runtime";
import type { BrainSpec } from "@usine/core/agent/brain";
import type { WorkerName } from "@usine/core/worker";
import { Effect, Option } from "effect";
import {
  type ExecutorError,
  logPreflightFailure,
  WorkerCapabilityError,
  type WorkerCapability,
} from "../executor.ts";
import { type HarnessProbe, verifyHarnessReadiness } from "../harness-preflight.ts";
import { verifyLinuxMemory } from "../memory-preflight.ts";
import type { RemoteCommands } from "../remote/commands.ts";
import { verifyGateway } from "./gateway/preflight.ts";
import type { SshMachine } from "./model.ts";

/** Succeeds when `$1` is a directory the SSH user can write to. */
const WRITABLE_DIRECTORY_SCRIPT = 'test -d "$1" && test -w "$1"';

const capabilityError = (
  worker: WorkerName,
  capability: WorkerCapability,
  message: string,
  cause: unknown,
): WorkerCapabilityError => new WorkerCapabilityError({ worker, capability, message, cause });

/**
 * Verifies an SSH Worker without changing its machine: the SSH client connects
 * to it, the configured root is a writable directory, Git runs, its memory
 * carries its concurrent Attempts, the Gateway in front of it answers and is
 * reachable from it when it has one, and each rostered brain is ready where
 * the Attempt's children run, a Claude brain under the Worker's lock in `logins`.
 */
export const sshPreflightFor = (
  commands: RemoteCommands,
  machineFor: (worker: WorkerName) => Effect.Effect<SshMachine, ExecutorError>,
  harnessProbe: (machine: SshMachine) => HarnessProbe,
  logins: ClaudeLoginLock["Service"],
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
            `Could not connect to SSH Worker ${worker} at ${host}`,
            cause,
          ),
        ),
      );
    if (connected.exitCode !== 0)
      return yield* capabilityError(
        worker,
        "machine",
        `Could not connect to SSH Worker ${worker} at ${host}`,
        new Error(connected.stderr.trim() || `ssh exited with code ${String(connected.exitCode)}`),
      );
    const rootChecked = yield* commands
      .inspect("preflight", machine.shell, "sh", ["-c", WRITABLE_DIRECTORY_SCRIPT, "sh", root])
      .pipe(
        Effect.mapError((cause) =>
          capabilityError(worker, "machine", `Could not inspect ${root} on ${host}`, cause),
        ),
      );
    if (rootChecked.exitCode !== 0)
      return yield* capabilityError(
        worker,
        "machine",
        `SSH Worker ${worker}'s root ${root} is not a writable directory on ${host}`,
        new Error(rootChecked.stderr.trim() || `exit code ${String(rootChecked.exitCode)}`),
      );
    const gitVersion = (yield* commands
      .run("preflight", machine.shell, "git", ["--version"])
      .pipe(
        Effect.mapError((cause) =>
          capabilityError(worker, "toolchain", `Worker ${worker} cannot run Git`, cause),
        ),
      )).trim();
    if (!gitVersion.startsWith("git version "))
      return yield* capabilityError(
        worker,
        "toolchain",
        `Worker ${worker} returned an unrecognized Git version`,
        new Error(gitVersion),
      );
    yield* verifyLinuxMemory(
      worker,
      maxConcurrentAttempts,
      commands.run("preflight", machine.shell, "cat", ["/proc/meminfo"]),
    );

    if (Option.isSome(machine.gateway))
      yield* verifyGateway(commands, worker, machine, machine.gateway.value);
    yield* verifyHarnessReadiness(worker, brains, harnessProbe(machine), logins);
    yield* Effect.logInfo("SSH Worker preflight verified", {
      worker,
      host,
      root,
      gitVersion,
      harnesses: [...new Set(brains.map(({ harness }) => harness))].join(","),
    });
  }, logPreflightFailure);
