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
 * Reads which kind of Anthropic credential the Gateway pays Claude Code
 * with, and records it with the Worker so its children's sessions name the
 * pool that pays (ADR 0013). A Gateway that holds no Anthropic credential
 * while the Worker's `llmProviders` lists it would refuse every Claude Code
 * request, so it fails the preflight. A Gateway too old to report its
 * credentials keeps the Claude plan pool, with a warning.
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
      Effect.logWarning(
        "SSH Worker's Gateway does not report the kind of its Anthropic credential; its Claude Code children count in the Claude plan pool until the Gateway is upgraded",
        { worker, gateway: gateway.forward.gateway },
      ).pipe(Effect.as(Option.none<GatewayCredentialKind>())),
    onSome: ({ providers }) => {
      const anthropic = providers.find(({ provider }) => provider === "anthropic");
      return anthropic === undefined
        ? Effect.fail(
            gatewayGap(
              worker,
              `SSH Worker ${worker}'s Gateway holds no Anthropic credential, but the Worker's llm_providers lists anthropic; set ANTHROPIC_API_KEY or USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN on the Gateway, or remove anthropic from llm_providers`,
              new Error(
                `the Gateway reports ${providers.map(({ provider }) => provider).join(", ") || "no provider"}`,
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
 * The kind of credential the Gateway pays a child of `harness` with, as the
 * Worker's last preflight recorded it: Claude Code's Anthropic credential
 * when the Gateway holds it. Codex and Pi pay with their own logins.
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
 * Verifies the Gateway in front of an SSH Worker without attaching anything:
 * the executor's forward to its admin API opens, the admin API answers this
 * process with the admin token, the machine's sshd accepts the variables
 * that carry the caller token, and the machine resolves and reaches
 * `git.<domain>`, which refuses a request without a caller token. When the
 * Gateway holds the Anthropic credential, it records the kind of that
 * credential with the Worker (`recordAnthropicCredential`).
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
        `Could not open the forward to SSH Worker ${worker}'s Gateway admin API through ${closed.gateway}: ${closed.reason}; run ${forward.command} to see why`,
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
    gateway: forward.gateway,
    adminPort: settings.adminPort,
    forwardPort: open.url.port,
    llmProviders: settings.llmProviders.join(","),
    anthropicCredential: Option.getOrElse(anthropicCredential, () => "none"),
    attachments: attachments.filter((attachment) => attachment.worker === worker).length,
  });
});

/**
 * The harnesses that can use the operator's login on the Worker's machine,
 * and the hosts that login calls through the Gateway's forward proxy: the
 * model API, and the OAuth endpoint that the login and its token refreshes
 * call. `infra/hetzner/gateway/egress-allowlist` lists them.
 */
const LOGINS = {
  claude: { label: "Claude Code", hosts: ["api.anthropic.com", "platform.claude.com"] },
  codex: { label: "Codex", hosts: ["chatgpt.com", "auth.openai.com"] },
} as const satisfies Partial<
  Record<Harness, { readonly label: string; readonly hosts: ReadonlyArray<string> }>
>;

type LoginHarness = keyof typeof LOGINS;

/**
 * Takes the forward proxy's URL and host names, and prints one line per
 * host: the host, curl's exit code, the proxy's answer to CONNECT, and the
 * host's HTTP status, which is 000 when the host did not answer.
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

/** The status the forward proxy answers a CONNECT with when its allowlist does not list the host. */
const PROXY_REFUSED = "403";

/**
 * Checks a brain on a Worker behind a Gateway (ADR 0027). When the Gateway
 * holds the Anthropic credential, Claude Code calls it at `llm.<domain>`
 * and only its binary is checked. Otherwise Claude Code, and Codex always,
 * use the operator's login on the machine, as on a Worker without a Gateway
 * (ADR 0026): `probe` checks the login, then the machine must reach the
 * login's hosts through the forward proxy. Pi goes to `probe`, which refuses
 * it on any remote machine.
 */
export const gatewayHarnessProbe = (
  commands: RemoteCommands,
  machine: SshMachine,
  gateway: MachineGateway,
  probe: HarnessProbe,
): HarnessProbe => {
  const worker = machine.address.name;
  const host = machine.shell.destination;
  const { domain } = gateway.settings;
  const proxy = forwardProxyUrl(domain);

  const claudeBinary = Effect.fn("SshExecutor.probeClaudeBehindGateway")(function* () {
    yield* Effect.annotateCurrentSpan({ host, domain });
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

  const loginHostsReachable = Effect.fn("SshExecutor.probeLoginHostsBehindGateway")(function* (
    harness: LoginHarness,
  ) {
    const { label, hosts } = LOGINS[harness];
    yield* Effect.annotateCurrentSpan({ worker, host, domain, harness });
    const result = yield* commands.inspect("preflight", machine.shell, "sh", [
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
          ? `no answer for ${loginHost}: ${result.stderr.trim() || `sh exited with code ${String(result.exitCode)}`}`
          : `curl exited with code ${answer.exitCode}; the proxy answered CONNECT with ${answer.connect}`,
      );
      return yield* gatewayGap(
        worker,
        answer?.connect === PROXY_REFUSED
          ? `${label} uses its login on SSH Worker ${worker}, and the Gateway's forward proxy refuses ${loginHost}; add ${loginHost} to the Gateway's egress allowlist`
          : `${label} uses its login on SSH Worker ${worker}, which cannot reach ${loginHost} through the Gateway's forward proxy at ${proxy}`,
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
