import type { BrainSpec } from "@usine/core/agent/brain";
import { HarnessUnavailableError } from "@usine/core/agent/capability";
import type { GatewayLlmProvider, WorkerName } from "@usine/core/worker";
import { Array as Arr, DateTime, Effect, Option, Ref, Duration } from "effect";
import {
  MachineCheck,
  WorkerCapabilityError,
  type ExecutorError,
  type PreflightReport,
} from "../../executor.ts";
import { gatewayHolds, provisionedApiKey } from "../api-keys.ts";
import type { SshMachine } from "../model.ts";
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
      new WorkerCapabilityError({
        worker,
        capability: "harness-login",
        message,
        cause: new HarnessUnavailableError({ harness, capability: "login", message }),
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
) =>
  Effect.gen(function* () {
    const checkedOn = yield* Ref.make<ReadonlyMap<WorkerName, number>>(new Map());
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
      const last = (yield* Ref.get(checkedOn)).get(worker);
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
        "Checking a provisioned Worker machine: Git, memory, the Gateway, Docker, the container limits, and the harnesses",
        { worker, host: machine.shell.destination, brains: brains.length },
      );
      const report = yield* verify(machine, brains, 1).pipe(
        Effect.timeoutOrElse({
          duration: Duration.seconds(provisioner.provisioner.timings.sshWait),
          orElse: () =>
            Effect.fail(
              new WorkerCapabilityError({
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
              new WorkerCapabilityError({
                worker,
                capability: "machine",
                message: `The check of the new machine of worker "${worker}" couldn't run: ${error.message}`,
                cause: error,
              }),
            ),
          CredentialUnavailableError: (error) =>
            Effect.fail(
              new WorkerCapabilityError({
                worker,
                capability: "credentials",
                message: error.message,
                cause: error,
              }),
            ),
        }),
      );
      if (Option.isSome(provisioner.provisioner.reuse) && Option.isSome(report.degraded))
        return yield* new WorkerCapabilityError({
          worker,
          capability: "container",
          message: "Machine reuse requires Docker isolation",
          cause: new Error(report.degraded.value),
        });
      const checkedAt = DateTime.toEpochMillis(yield* DateTime.now);
      yield* Ref.update(checkedOn, (current) => new Map(current).set(worker, checkedAt));
      return Option.some(new MachineCheck({ brains, containerLimits: report.containerLimits }));
    });

    return {
      check: checkMachine,
      forget: (worker: WorkerName) =>
        Ref.update(checkedOn, (current) => {
          const next = new Map(current);
          next.delete(worker);
          return next;
        }),
    };
  });
