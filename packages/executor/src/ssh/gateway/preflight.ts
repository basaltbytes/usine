import { HarnessReady, HarnessUnavailableError } from "@usine/core/agent/capability";
import type { WorkerName } from "@usine/core/worker";
import { Effect, Redacted } from "effect";
import type { CommandResult } from "../../child-command.ts";
import { ExecutorOperationError, WorkerCapabilityError } from "../../executor.ts";
import type { HarnessProbe } from "../../harness-preflight.ts";
import { type RemoteCommands, sendingShell } from "../../remote/commands.ts";
import type { MachineGateway, SshMachine } from "../model.ts";
import { GATEWAY_SENT_VARIABLES, gatewayEnvironment } from "./environment.ts";

/** A stand-in caller token, so preflight can check what reaches the machine without attaching anything. */
const PROBE_TOKEN = Redacted.make("usine-preflight");

/** Takes name and value argument pairs and prints each name whose variable does not have that value on the machine. */
const SENT_VARIABLES_SCRIPT = `
while [ "$#" -gt 1 ]; do
  test "$(printenv "$1")" = "$2" || echo "$1"
  shift 2
done
`.trim();

/** The header the Gateway names its refusal in, and the reason it gives a request without a caller token. */
const REFUSED_WITHOUT_TOKEN = /^x-usine-gateway-refusal:\s*missing-caller-token\s*$/imu;

/** OpenSSH exits with 255 when it cannot reach the machine or run the command there. */
const SSH_FAILURE = 255;

const gatewayGap = (worker: WorkerName, message: string, cause: unknown) =>
  new WorkerCapabilityError({ worker, capability: "gateway", message, cause });

/** The SSH client could not reach the machine to run `command`: a transport failure, not a capability gap. */
const unreachable = (host: string, command: string, result: CommandResult) =>
  new ExecutorOperationError({
    operation: "preflight",
    message: `Could not reach ${host} to run ${command}`,
    cause: new Error(result.stderr.trim() || `ssh exited with code ${SSH_FAILURE}`),
  });

/**
 * Verifies the Gateway in front of an SSH Worker without attaching anything:
 * its admin API answers this process with the admin token, the machine's
 * sshd accepts the variables that carry the caller token, and the machine
 * resolves and reaches `git.<domain>`, which refuses a request without a
 * caller token.
 */
export const verifyGateway = Effect.fn("SshExecutor.verifyGateway")(function* (
  commands: RemoteCommands,
  worker: WorkerName,
  machine: SshMachine,
  gateway: MachineGateway,
) {
  const { admin, settings } = gateway;
  const gitHost = `git.${settings.domain}`;
  yield* Effect.annotateCurrentSpan({ worker, domain: settings.domain });
  const { attachments } = yield* admin.list.pipe(
    Effect.mapError((error) =>
      gatewayGap(
        worker,
        `${error.message}; check that the forward to the Gateway's admin API is open`,
        error,
      ),
    ),
  );

  const { sent } = gatewayEnvironment({
    domain: settings.domain,
    llmProviders: settings.llmProviders,
    ghConfigDirectory: machine.workerDirectory,
    callerToken: PROBE_TOKEN,
  });
  const received = yield* commands.run("preflight", sendingShell(machine.shell, sent), "sh", [
    "-c",
    SENT_VARIABLES_SCRIPT,
    "sh",
    ...Object.entries(sent).flatMap(([name, value]) => [name, Redacted.value(value)]),
  ]);
  const dropped = received.split("\n").filter((name) => name !== "");
  if (dropped.length > 0)
    return yield* gatewayGap(
      worker,
      `SSH Worker ${worker}'s sshd drops ${dropped.join(", ")}; add AcceptEnv ${GATEWAY_SENT_VARIABLES.join(" ")} to its sshd configuration`,
      new Error(`variables not received: ${dropped.join(" ")}`),
    );

  const probed = yield* commands.inspect("preflight", machine.shell, "curl", [
    "-sS",
    "--noproxy",
    "*",
    "--max-time",
    "15",
    "-o",
    "/dev/null",
    "-D",
    "-",
    `http://${gitHost}/`,
  ]);
  if (probed.exitCode === SSH_FAILURE)
    return yield* unreachable(machine.shell.destination, "curl", probed);
  if (probed.exitCode !== 0 || !REFUSED_WITHOUT_TOKEN.test(probed.stdout))
    return yield* gatewayGap(
      worker,
      `SSH Worker ${worker} cannot reach its Gateway at ${gitHost}`,
      new Error(
        probed.stderr.trim() ||
          probed.stdout.split("\n")[0]?.trim() ||
          `curl exited with code ${String(probed.exitCode)}`,
      ),
    );
  yield* Effect.logInfo("SSH Worker Gateway verified", {
    worker,
    domain: settings.domain,
    adminUrl: settings.adminUrl.href,
    llmProviders: settings.llmProviders.join(","),
    attachments: attachments.filter((attachment) => attachment.worker === worker).length,
  });
});

/**
 * Checks a brain on a Worker behind a Gateway, where a harness reaches its
 * provider only through the Gateway (ADR 0027). Claude Code needs the
 * Gateway's Anthropic credential, and then only its binary is checked, since
 * its login is the Gateway's. Codex has no route yet (#244). Pi goes to
 * `probe`, which refuses it on any remote machine.
 */
export const gatewayHarnessProbe = (
  commands: RemoteCommands,
  machine: SshMachine,
  gateway: MachineGateway,
  probe: HarnessProbe,
): HarnessProbe => {
  const claudeBinary = Effect.fn("SshExecutor.probeClaudeBehindGateway")(function* () {
    const host = machine.shell.destination;
    yield* Effect.annotateCurrentSpan({ host, domain: gateway.settings.domain });
    const result = yield* commands.inspect("preflight", machine.shell, "claude", ["--version"]);
    if (result.exitCode === SSH_FAILURE) return yield* unreachable(host, "claude", result);
    if (result.exitCode !== 0)
      return new HarnessUnavailableError({
        harness: "claude",
        capability: "binary",
        message: "claude --version failed; check the Worker's claude installation",
      });
    yield* Effect.logInfo(
      "Claude Code uses the Gateway's Anthropic credential; checked its binary only",
      { host, version: result.stdout.trim() },
    );
    return new HarnessReady({ harness: "claude" });
  });
  return (brain) => {
    switch (brain.harness) {
      case "claude":
        return gateway.settings.llmProviders.includes("anthropic")
          ? claudeBinary()
          : Effect.succeed(
              new HarnessUnavailableError({
                harness: "claude",
                capability: "login",
                message:
                  "Claude Code has no route to Anthropic from behind a Gateway that does not hold the Anthropic credential; list anthropic under the Worker's gateway llm_providers",
              }),
            );
      case "codex":
        return Effect.succeed(
          new HarnessUnavailableError({
            harness: "codex",
            capability: "login",
            message:
              "Codex children have no route to OpenAI from behind a Gateway yet (https://github.com/basaltbytes/usine/issues/244)",
          }),
        );
      case "pi":
        return probe(brain);
    }
  };
};
