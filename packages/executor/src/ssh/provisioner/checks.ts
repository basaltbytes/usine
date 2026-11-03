import { RemoteShell, SSH_FAILURE } from "@usine/agents/child-host";
import type { RemoteCommands } from "../../remote/commands.ts";
import type { BrainSpec } from "@usine/core/agent/brain";
import { HarnessUnavailableError } from "@usine/core/agent/capability";
import type { GatewayLlmProvider } from "@usine/core/worker";
import { Array as Arr, DateTime, Effect, Option, Duration } from "effect";
import {
  MachineCheck,
  WorkerCapabilityError,
  type ExecutorError,
  type PreflightReport,
} from "../../executor.ts";
import { gatewayHolds, provisionedApiKey } from "../api-keys.ts";
import type { SshMachine, SshWorkerAddress } from "../model.ts";
import type { SshWorkerEntry } from "../workers.ts";

/**
 * Returns the error for the first harness in `brains` that can't authenticate on a machine
 * without a stored login: one whose provider credential is neither at
 * the Gateway nor in the provisioner's `api_keys`.
 */
export const harnessCredentialGap = (
  entry: SshWorkerEntry,
  brains: ReadonlyArray<BrainSpec>,
): Option.Option<WorkerCapabilityError> => {
  const worker = entry.address.name;
  const noGateway = "A subscription login needs a gateway, which this worker doesn't have.";
  const missing = (label: string, provider: GatewayLlmProvider, login: string) => {
    const head = `${label} on provisioned worker "${worker}" has no credential, because provisioned machines have no stored login.`;
    return Option.isSome(entry.gateway)
      ? `${head} Add ${provider} to the gateway's llm_providers, with ${login} or an API key on the gateway, or set provisioner.api_keys.${provider}.`
      : `${head} Set provisioner.api_keys.${provider}. ${noGateway}`;
  };
  for (const harness of Arr.dedupe(brains.map((brain) => brain.harness))) {
    if (gatewayHolds(entry.gateway, harness) || Option.isSome(provisionedApiKey(entry, harness)))
      continue;
    const message = (() => {
      switch (harness) {
        case "claude":
          return missing("Claude Code", "anthropic", "a subscription token");
        case "codex":
          return missing("Codex", "openai", "a ChatGPT login");
        case "pi":
          return `Pi children run only on local workers, not on provisioned worker "${worker}".`;
      }
    })();
    return Option.some(
      WorkerCapabilityError.make({
        worker,
        capability: "harness-login",
        message,
        cause: HarnessUnavailableError.make({ harness, capability: "login", message }),
      }),
    );
  }
  return Option.none();
};

export const machineChecksFor = (
  verify: (
    machine: SshMachine,
    brains: ReadonlyArray<BrainSpec>,
    slots: number,
  ) => Effect.Effect<PreflightReport, ExecutorError>,
) => {
  const checkedOn = new WeakMap<SshWorkerAddress, number>();
  /**
   * Checks every reused machine before assignment; single-use machines use the configured interval.
   * Container limits always apply to one attempt per machine.
   */
  const checkMachine = Effect.fn("SshExecutor.checkMachine")(function* (
    machine: SshMachine,
    brains: ReadonlyArray<BrainSpec>,
  ) {
    const worker = machine.address.name;
    yield* Effect.annotateCurrentSpan({ worker, host: machine.shell.destination });
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const last = checkedOn.get(machine.address);
    const provisioner = machine.address.machine;
    if (provisioner._tag !== "Provisioned")
      return yield* Effect.die(new Error("expected a provisioned machine"));
    if (
      Option.isNone(provisioner.provisioner.reuse) &&
      last !== undefined &&
      now - last < provisioner.provisioner.timings.machineCheckInterval * 1000
    ) {
      yield* Effect.logDebug("Machine check interval has not elapsed", {
        worker,
        lastCheckedAt: last,
      });
      return Option.none<MachineCheck>();
    }
    yield* Effect.logInfo(
      "Checking a provisioned Worker machine: Git, memory, the Gateway, the container runtime, the container limits, and the harnesses",
      { worker, host: machine.shell.destination, brains: brains.length },
    );
    const report = yield* verify(machine, brains, 1).pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(provisioner.provisioner.timings.sshWait),
        orElse: () =>
          Effect.fail(
            WorkerCapabilityError.make({
              worker,
              capability: "machine",
              message: "Machine preflight timed out",
              cause: new Error("machine preflight timeout"),
            }),
          ),
      }),
      Effect.catchTags({
        ExecutorOperationError: (error) =>
          Effect.fail(
            WorkerCapabilityError.make({
              worker,
              capability: "machine",
              message: `The check of the new machine of worker "${worker}" couldn't run: ${error.message}`,
              cause: error,
            }),
          ),
        CredentialUnavailableError: (error) =>
          Effect.fail(
            WorkerCapabilityError.make({
              worker,
              capability: "credentials",
              message: error.message,
              cause: error,
            }),
          ),
      }),
    );
    if (Option.isSome(provisioner.provisioner.reuse) && Option.isSome(report.degraded))
      return yield* WorkerCapabilityError.make({
        worker,
        capability: "container",
        message: "Machine reuse requires container isolation",
        cause: new Error(report.degraded.value),
      });
    const checkedAt = DateTime.toEpochMillis(yield* DateTime.now);
    checkedOn.set(machine.address, checkedAt);
    return Option.some(MachineCheck.make({ brains, containerLimits: report.containerLimits }));
  });

  return { check: checkMachine };
};

/**
 * A script that waits for cloud-init to finish, if the machine has it, creates the Worker root
 * `$1`, and waits up to a minute for the container runtime to answer, if the machine has it.
 */
const READY_SCRIPT = String.raw`
if command -v cloud-init >/dev/null 2>&1; then cloud-init status --wait >/dev/null 2>&1 || true; fi
mkdir -p "$1" || exit 1
runtime=docker
if [ -f /etc/usine/container-runtime ]; then runtime=$(cat /etc/usine/container-runtime)
elif command -v podman >/dev/null 2>&1; then runtime=podman; fi
case "$runtime" in podman|docker) ;; *) exit 1 ;; esac
if command -v "$runtime" >/dev/null 2>&1; then
  tries=0
  until "$runtime" info >/dev/null 2>&1; do
    tries=$((tries + 1))
    [ "$tries" -ge 30 ] && break
    sleep 2
  done
fi
`.trim();

/** Waits until the machine answers over SSH and runs `READY_SCRIPT`. */
export const awaitMachineSsh = Effect.fn("SshExecutor.awaitMachineSsh")(function* (
  commands: RemoteCommands,
  interval: Effect.Effect<void>,
  machine: SshMachine,
) {
  const worker = machine.address.name;
  const host = machine.shell.destination;
  yield* Effect.annotateCurrentSpan({ worker, host });
  const shell = RemoteShell.make({
    ssh: {
      command: machine.shell.ssh.command,
      args: [...machine.shell.ssh.args, "-o", "ConnectTimeout=10"],
    },
    sshEnvironment: machine.shell.sshEnvironment,
    destination: machine.shell.destination,
  });
  let tries = 0;
  while (true) {
    tries += 1;
    const result = yield* commands.inspect("prepare", shell, "sh", [
      "-c",
      READY_SCRIPT,
      "sh",
      machine.address.root,
    ]);
    if (result.exitCode === 0) {
      yield* Effect.logInfo("The new machine answers over SSH", { worker, host, tries });
      return;
    }
    if (result.exitCode !== SSH_FAILURE)
      return yield* WorkerCapabilityError.make({
        worker,
        capability: "machine",
        message: `The new machine of worker "${worker}" at ${host} can't create the root ${machine.address.root}`,
        cause: new Error(result.stderr.trim() || `exit code ${String(result.exitCode)}`),
      });
    yield* Effect.logDebug("The new machine doesn't answer over SSH yet", {
      worker,
      host,
      tries,
      message: result.stderr.trim(),
    });
    yield* interval;
  }
});
