import type { RemoteShell } from "@usine/agents/child-host";
import type { BrainSpec, Harness } from "@usine/core/agent/brain";
import { HarnessReady, HarnessUnavailableError } from "@usine/core/agent/capability";
import type { GatewayCredentialKind, WorkerName } from "@usine/core/worker";
import { Effect, Option, Redacted, Ref } from "effect";
import type { CommandResult } from "../../child-command.ts";
import { ExecutorOperationError, WorkerCapabilityError } from "../../executor.ts";
import type { HarnessProbe } from "../../harness-preflight.ts";
import { type RemoteCommands, sendingShell } from "../../remote/commands.ts";
import type { MachineGateway, SshMachine } from "../model.ts";
import { forwardProxyUrl, GATEWAY_SENT_VARIABLES, gatewayEnvironment } from "./environment.ts";

/** A placeholder caller token that lets preflight check the sent variables without attaching anything. */
const PROBE_TOKEN = Redacted.make("usine-preflight");

/** A script that takes name and value pairs and prints each name whose variable doesn't have that value on the machine. */
const SENT_VARIABLES_SCRIPT = `
while [ "$#" -gt 1 ]; do
  test "$(printenv "$1")" = "$2" || echo "$1"
  shift 2
done
`.trim();

/** Matches the Gateway's refusal header for a request without a caller token. */
const REFUSED_WITHOUT_TOKEN = /^x-usine-gateway-refusal:\s*missing-caller-token\s*$/imu;

/** The exit code OpenSSH uses when it can't connect to the machine or run the command. */
const SSH_FAILURE = 255;

const gatewayGap = (worker: WorkerName, message: string, cause: unknown) =>
  new WorkerCapabilityError({ worker, capability: "gateway", message, cause });

/** Returns the error for an SSH transport failure, which isn't a capability gap. */
const unreachable = (host: string, command: string, result: CommandResult) =>
  new ExecutorOperationError({
    operation: "preflight",
    message: `Can't reach ${host} to run ${command}`,
    cause: new Error(result.stderr.trim() || `ssh exited with code ${SSH_FAILURE}`),
  });

/**
 * Logs a warning, once per Worker, that the Gateway is too old to report its Anthropic
 * credential kind (#248). Later preflights log at debug level.
 */
const warnOfUnreportedCredential = (worker: WorkerName, gateway: MachineGateway) =>
  Ref.getAndSet(gateway.warnedOfUnreportedCredential, true).pipe(
    Effect.flatMap((warned) =>
      warned
        ? Effect.logDebug(
            "SSH Worker's Gateway still does not report the kind of its Anthropic credential; already warned for this Worker",
            { worker, gateway: gateway.forward.gateway },
          )
        : Effect.logWarning(
            "SSH Worker's Gateway does not report the kind of its Anthropic credential; its Claude Code children count in the Claude plan pool until the Gateway is upgraded",
            { worker, gateway: gateway.forward.gateway },
          ),
    ),
  );

/**
 * Reads the Gateway's Anthropic credential kind and records it for the Worker (ADR 0013).
 * Fails if the Worker's `llmProviders` includes Anthropic and the Gateway has no Anthropic
 * credential. If the Gateway is too old to report credentials, keeps the Claude plan pool and
 * logs a warning.
 */
const recordAnthropicCredential = Effect.fn("SshExecutor.recordAnthropicCredential")(function* (
  worker: WorkerName,
  gateway: MachineGateway,
) {
  yield* Effect.annotateCurrentSpan({ worker, gateway: gateway.forward.gateway });
  const reported = yield* gateway.admin.providers.pipe(
    Effect.mapError((error) => gatewayGap(worker, error.message, error)),
  );
  const credential = yield* Option.match(reported, {
    onNone: () =>
      warnOfUnreportedCredential(worker, gateway).pipe(
        Effect.as(Option.none<GatewayCredentialKind>()),
      ),
    onSome: ({ providers }) => {
      const anthropic = providers.find(({ provider }) => provider === "anthropic");
      return anthropic === undefined
        ? Effect.fail(
            gatewayGap(
              worker,
              `The gateway of SSH worker "${worker}" has no Anthropic credential, but the worker's llm_providers includes anthropic. Set ANTHROPIC_API_KEY or USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN on the gateway, or remove anthropic from llm_providers.`,
              new Error(
                `the gateway reports ${providers.map(({ provider }) => provider).join(", ") || "no provider"}`,
              ),
            ),
          )
        : Effect.succeed(Option.some(anthropic.credential));
    },
  });
  yield* Ref.set(gateway.anthropicCredential, credential);
  return credential;
});

/**
 * Returns the credential kind the Gateway injects for `harness`, as recorded by the last
 * preflight. Only Claude Code uses a Gateway credential; Codex and Pi use their own logins.
 */
export const gatewayCredentialFor = (
  gateway: MachineGateway,
  harness: Harness,
): Effect.Effect<Option.Option<GatewayCredentialKind>> => {
  switch (harness) {
    case "claude":
      return Ref.get(gateway.anthropicCredential);
    case "codex":
    case "pi":
      return Effect.succeedNone;
  }
};

/**
 * Verifies the Gateway in front of an SSH Worker without attaching anything: the admin API
 * forward opens and accepts the admin token, the machine's sshd accepts the caller-token
 * variables, and the machine can connect to `git.<domain>`, which rejects a request without a caller
 * token. If the Gateway has the Anthropic credential, records its kind for the Worker.
 */
export const verifyGateway = Effect.fn("SshExecutor.verifyGateway")(function* (
  commands: RemoteCommands,
  worker: WorkerName,
  machine: SshMachine,
  gateway: MachineGateway,
) {
  const { admin, forward, settings } = gateway;
  const gitHost = `git.${settings.domain}`;
  yield* Effect.annotateCurrentSpan({ worker, domain: settings.domain, gateway: forward.gateway });
  const open = yield* forward.current.pipe(
    Effect.catchTag("GatewayForwardClosed", (closed) => forward.reopen(closed.generation)),
    Effect.mapError((closed) =>
      gatewayGap(
        worker,
        `Can't open the forward to the gateway admin API of SSH worker "${worker}" through ${closed.gateway}: ${closed.reason}. Run ${forward.command} to see the SSH error.`,
        closed,
      ),
    ),
  );
  const { attachments } = yield* admin.list.pipe(
    Effect.mapError((error) => gatewayGap(worker, error.message, error)),
  );
  const anthropicCredential = settings.llmProviders.includes("anthropic")
    ? yield* recordAnthropicCredential(worker, gateway)
    : Option.none<GatewayCredentialKind>();

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
      `The sshd on SSH worker "${worker}" doesn't accept ${dropped.join(", ")}. Add AcceptEnv ${GATEWAY_SENT_VARIABLES.join(" ")} to its sshd configuration.`,
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
      `SSH worker "${worker}" can't reach its gateway at ${gitHost}`,
      new Error(
        probed.stderr.trim() ||
          probed.stdout.split("\n")[0]?.trim() ||
          `curl exited with code ${String(probed.exitCode)}`,
      ),
    );
  yield* Effect.logInfo("SSH Worker Gateway verified", {
    worker,
    domain: settings.domain,
    gateway: forward.gateway,
    adminPort: settings.adminPort,
    forwardPort: open.url.port,
    llmProviders: settings.llmProviders.join(","),
    anthropicCredential: Option.getOrElse(anthropicCredential, () => "none"),
    attachments: attachments.filter((attachment) => attachment.worker === worker).length,
  });
});

/**
 * The harnesses that can use the operator's login on the machine, with the hosts each login
 * calls through the forward proxy. `infra/hetzner/gateway/egress-allowlist` lists the same
 * hosts.
 */
const LOGINS = {
  claude: { label: "Claude Code", hosts: ["api.anthropic.com", "platform.claude.com"] },
  codex: { label: "Codex", hosts: ["chatgpt.com", "auth.openai.com"] },
} as const satisfies Partial<
  Record<Harness, { readonly label: string; readonly hosts: ReadonlyArray<string> }>
>;

type LoginHarness = keyof typeof LOGINS;

/**
 * A script that takes the forward proxy URL and host names, and prints one line per host: the
 * host, curl's exit code, the proxy's CONNECT status, and the host's HTTP status (`000` if the
 * host didn't respond).
 */
const LOGIN_HOSTS_SCRIPT = `
proxy=$1
shift
for host in "$@"; do
  codes=$(curl -s -o /dev/null --max-time 10 --proxy "$proxy" -w '%{http_connect} %{http_code}' "https://$host/")
  echo "$host $? $codes"
done
`.trim();

const LOGIN_HOST_ANSWER = /^(\S+) (\d+) (\d{3}) (\d{3})$/u;

/** The CONNECT status the forward proxy returns for a host that isn't in its allowlist. */
const PROXY_REFUSED = "403";

/**
 * Probes a brain on a Worker behind a Gateway (ADR 0027). If the Gateway has the Anthropic
 * credential, checks only the Claude Code binary. Otherwise, Claude Code and Codex use the
 * operator's login (ADR 0026): `probe` checks the login, then the machine must connect to the
 * login's hosts through the forward proxy. Pi goes to `probe`, which rejects it on any remote
 * machine. The checks run through `shell`, on the machine or in a container on it.
 */
export const gatewayHarnessProbe = (
  commands: RemoteCommands,
  machine: SshMachine,
  gateway: MachineGateway,
  probe: HarnessProbe,
  shell: RemoteShell,
): HarnessProbe => {
  const worker = machine.address.name;
  const host = machine.shell.destination;
  const { domain } = gateway.settings;
  const proxy = forwardProxyUrl(domain);

  const claudeBinary = Effect.fn("SshExecutor.probeClaudeBehindGateway")(function* () {
    yield* Effect.annotateCurrentSpan({ host, domain });
    const result = yield* commands.inspect("preflight", shell, "claude", ["--version"]);
    if (result.exitCode === SSH_FAILURE) return yield* unreachable(host, "claude", result);
    if (result.exitCode !== 0)
      return new HarnessUnavailableError({
        harness: "claude",
        capability: "binary",
        message: "claude --version failed. Check the Claude Code installation on the worker.",
      });
    yield* Effect.logInfo(
      "Claude Code uses the Gateway's Anthropic credential; checked its binary only",
      { host, version: result.stdout.trim() },
    );
    return new HarnessReady({ harness: "claude" });
  });

  const loginHostsReachable = Effect.fn("SshExecutor.probeLoginHostsBehindGateway")(function* (
    harness: LoginHarness,
  ) {
    const { label, hosts } = LOGINS[harness];
    yield* Effect.annotateCurrentSpan({ worker, host, domain, harness });
    const result = yield* commands.inspect("preflight", shell, "sh", [
      "-c",
      LOGIN_HOSTS_SCRIPT,
      "sh",
      proxy,
      ...hosts,
    ]);
    if (result.exitCode === SSH_FAILURE) return yield* unreachable(host, "curl", result);
    const answers = new Map(
      result.stdout.split("\n").flatMap((line) => {
        const match = LOGIN_HOST_ANSWER.exec(line.trim());
        return match === null
          ? []
          : [[match[1], { exitCode: match[2], connect: match[3], status: match[4] }] as const];
      }),
    );
    for (const loginHost of hosts) {
      const answer = answers.get(loginHost);
      if (answer !== undefined && answer.status !== "000") continue;
      const cause = new Error(
        answer === undefined
          ? `no response from ${loginHost}: ${result.stderr.trim() || `sh exited with code ${String(result.exitCode)}`}`
          : `curl exited with code ${answer.exitCode}; the proxy returned ${answer.connect} for CONNECT`,
      );
      return yield* gatewayGap(
        worker,
        answer?.connect === PROXY_REFUSED
          ? `${label} uses its login on SSH worker "${worker}", and the gateway's forward proxy blocks ${loginHost}. Add ${loginHost} to the gateway's egress allowlist.`
          : `${label} uses its login on SSH worker "${worker}", which can't reach ${loginHost} through the gateway's forward proxy at ${proxy}`,
        cause,
      );
    }
    yield* Effect.logInfo("SSH Worker reaches its harness login's hosts through the Gateway", {
      worker,
      harness,
      domain,
      hosts: hosts.join(","),
    });
  });

  const loginOnMachine = Effect.fn("SshExecutor.probeLoginBehindGateway")(function* (
    brain: BrainSpec,
    harness: LoginHarness,
  ) {
    yield* Effect.annotateCurrentSpan({ worker, host, domain, harness });
    const readiness = yield* probe(brain);
    if (readiness._tag === "HarnessUnavailableError") return readiness;
    yield* loginHostsReachable(harness);
    return readiness;
  });

  return (brain) => {
    switch (brain.harness) {
      case "claude":
        return gateway.settings.llmProviders.includes("anthropic")
          ? claudeBinary()
          : loginOnMachine(brain, "claude");
      case "codex":
        return loginOnMachine(brain, "codex");
      case "pi":
        return probe(brain);
    }
  };
};
