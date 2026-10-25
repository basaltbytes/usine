import type { RemoteShell } from "@usine/agents/child-host";
import { unsupportedCodexVersion } from "@usine/agents/preflight";
import type { BrainSpec, Harness } from "@usine/core/agent/brain";
import { HarnessReady, HarnessUnavailableError } from "@usine/core/agent/capability";
import type { GatewayCredentialKind, GatewayLlmProvider, WorkerName } from "@usine/core/worker";
import { Effect, Option, Redacted, Ref } from "effect";
import type { CommandResult } from "../../child-command.ts";
import { ExecutorOperationError, WorkerCapabilityError } from "../../executor.ts";
import type { HarnessProbe } from "../../harness-preflight.ts";
import { type RemoteCommands, sendingShell } from "../../remote/commands.ts";
import type { GatewayCredentials, MachineGateway, SshMachine } from "../model.ts";
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

/** Each provider's display name and the Gateway variables that set its credential. */
const PROVIDER_CREDENTIALS = {
  anthropic: {
    label: "Anthropic",
    variables: "ANTHROPIC_API_KEY or USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN",
  },
  openai: { label: "OpenAI", variables: "OPENAI_API_KEY or USINE_GATEWAY_CHATGPT_AUTH_FILE" },
} as const satisfies Record<
  GatewayLlmProvider,
  { readonly label: string; readonly variables: string }
>;

const NO_CREDENTIALS: GatewayCredentials = { anthropic: Option.none(), openai: Option.none() };

/**
 * Reads the Gateway's credential kind for each provider in the Worker's `llmProviders` and
 * records them for the Worker (ADR 0013). Fails if the Gateway has no credential for a listed
 * provider. If the Gateway is too old to report credentials, keeps the Claude plan pool for
 * Anthropic with a warning, and fails for OpenAI, which such a Gateway can't serve for Codex.
 */
const recordProviderCredentials = Effect.fn("SshExecutor.recordProviderCredentials")(function* (
  worker: WorkerName,
  gateway: MachineGateway,
) {
  const listed = gateway.settings.llmProviders;
  yield* Effect.annotateCurrentSpan({
    worker,
    gateway: gateway.forward.gateway,
    llmProviders: listed.join(","),
  });
  if (listed.length === 0) {
    yield* Ref.set(gateway.credentials, NO_CREDENTIALS);
    return NO_CREDENTIALS;
  }
  const reported = yield* gateway.admin.providers.pipe(
    Effect.mapError((error) => gatewayGap(worker, error.message, error)),
  );
  if (Option.isNone(reported)) {
    if (listed.includes("openai"))
      return yield* gatewayGap(
        worker,
        `The gateway of SSH worker "${worker}" doesn't report its LLM credentials, so Codex can't use its OpenAI credential. Upgrade @usine/gateway on the gateway, or remove openai from llm_providers.`,
        new Error("the gateway answered 404 for GET /v1/providers"),
      );
    yield* warnOfUnreportedCredential(worker, gateway);
    yield* Ref.set(gateway.credentials, NO_CREDENTIALS);
    return NO_CREDENTIALS;
  }
  const { providers } = reported.value;
  const kindOf = (provider: GatewayLlmProvider) =>
    Option.fromNullishOr(providers.find((held) => held.provider === provider)?.credential);
  const missing = listed.find((provider) => Option.isNone(kindOf(provider)));
  if (missing !== undefined)
    return yield* gatewayGap(
      worker,
      `The gateway of SSH worker "${worker}" has no ${PROVIDER_CREDENTIALS[missing].label} credential, but the worker's llm_providers includes ${missing}. Set ${PROVIDER_CREDENTIALS[missing].variables} on the gateway, or remove ${missing} from llm_providers.`,
      new Error(
        `the gateway reports ${providers.map(({ provider }) => provider).join(", ") || "no provider"}`,
      ),
    );
  const credentials: GatewayCredentials = {
    anthropic: listed.includes("anthropic") ? kindOf("anthropic") : Option.none(),
    openai: listed.includes("openai") ? kindOf("openai") : Option.none(),
  };
  yield* Ref.set(gateway.credentials, credentials);
  return credentials;
});

/** Returns how a provider's harness authenticates on the Worker, for log lines. */
const credentialMode = (kind: Option.Option<GatewayCredentialKind>, listed: boolean) =>
  Option.match(kind, {
    onNone: () => (listed ? "gateway-unreported" : "worker-login"),
    onSome: (credential) => `gateway-${credential}`,
  });

/**
 * Returns the credential kind the Gateway injects for `harness`, as recorded by the last
 * preflight: Anthropic's for Claude Code, OpenAI's for Codex. Pi uses its own login.
 */
export const gatewayCredentialFor = (
  gateway: MachineGateway,
  harness: Harness,
): Effect.Effect<Option.Option<GatewayCredentialKind>> => {
  switch (harness) {
    case "claude":
      return Effect.map(Ref.get(gateway.credentials), ({ anthropic }) => anthropic);
    case "codex":
      return Effect.map(Ref.get(gateway.credentials), ({ openai }) => openai);
    case "pi":
      return Effect.succeedNone;
  }
};

/**
 * Verifies the Gateway's admin API for an SSH Worker without attaching anything: the forward
 * opens and the admin API accepts the admin token. Records the Gateway's credential kind for
 * each provider in the Worker's `llmProviders`. Needs no Worker machine.
 */
export const verifyGatewayAdmin = Effect.fn("SshExecutor.verifyGatewayAdmin")(function* (
  worker: WorkerName,
  gateway: MachineGateway,
) {
  const { admin, forward, settings } = gateway;
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
  const credentials = yield* recordProviderCredentials(worker, gateway);
  yield* Effect.logInfo("SSH Worker Gateway admin API verified", {
    worker,
    domain: settings.domain,
    gateway: forward.gateway,
    adminPort: settings.adminPort,
    forwardPort: open.url.port,
    llmProviders: settings.llmProviders.join(","),
    anthropic: credentialMode(credentials.anthropic, settings.llmProviders.includes("anthropic")),
    openai: credentialMode(credentials.openai, settings.llmProviders.includes("openai")),
    attachments: attachments.filter((attachment) => attachment.worker === worker).length,
  });
});

/**
 * Verifies the Gateway from an SSH Worker's machine without attaching anything: the machine's
 * sshd accepts the caller-token variables, and the machine can connect to `git.<domain>`, which
 * rejects a request without a caller token.
 */
const verifyGatewayFromMachine = Effect.fn("SshExecutor.verifyGatewayFromMachine")(function* (
  commands: RemoteCommands,
  worker: WorkerName,
  machine: SshMachine,
  gateway: MachineGateway,
) {
  const { forward, settings } = gateway;
  const gitHost = `git.${settings.domain}`;
  yield* Effect.annotateCurrentSpan({ worker, domain: settings.domain, gateway: forward.gateway });
  const { sent } = gatewayEnvironment({
    domain: settings.domain,
    llmProviders: settings.llmProviders,
    ghConfigDirectory: machine.workerDirectory,
    codexHome: machine.workerDirectory,
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
  yield* Effect.logInfo("SSH Worker reaches its Gateway", {
    worker,
    host: machine.shell.destination,
    domain: settings.domain,
    gateway: forward.gateway,
  });
});

/**
 * Verifies the Gateway in front of an SSH Worker without attaching anything: the admin API
 * checks of `verifyGatewayAdmin`, then the machine checks of `verifyGatewayFromMachine`.
 */
export const verifyGateway = (
  commands: RemoteCommands,
  worker: WorkerName,
  machine: SshMachine,
  gateway: MachineGateway,
) =>
  verifyGatewayAdmin(worker, gateway).pipe(
    Effect.andThen(verifyGatewayFromMachine(commands, worker, machine, gateway)),
  );

/**
 * Checks only the binary of a harness whose credential the machine doesn't keep, the Gateway's
 * or an API key in the Attempt's environment, named by `credential` in the log. Codex's version
 * must also be supported.
 */
export const harnessBinaryProbe = Effect.fn("SshExecutor.probeHarnessBinary")(function* (
  commands: RemoteCommands,
  host: string,
  shell: RemoteShell,
  harness: "claude" | "codex",
  credential: string,
) {
  const label = harness === "claude" ? "Claude Code" : "Codex";
  yield* Effect.annotateCurrentSpan({ host, harness, credential });
  const result = yield* commands.inspect("preflight", shell, harness, ["--version"]);
  if (result.exitCode === SSH_FAILURE) return yield* unreachable(host, harness, result);
  if (result.exitCode !== 0)
    return new HarnessUnavailableError({
      harness,
      capability: "binary",
      message: `${harness} --version failed. Check the ${label} installation on the worker.`,
    });
  const version = result.stdout.trim();
  const unsupported = harness === "codex" ? unsupportedCodexVersion(version) : Option.none();
  if (Option.isSome(unsupported)) return unsupported.value;
  yield* Effect.logInfo(`${label} uses ${credential}; checked its binary only`, {
    host,
    harness,
    version,
  });
  return new HarnessReady({ harness });
});

/**
 * The harnesses that can use the operator's login on the machine or the Gateway's credential
 * for their provider, with the hosts each login calls through the forward proxy, which
 * `infra/hetzner/gateway/egress-allowlist` lists, and the API host that an API key in the
 * Attempt's environment calls.
 */
const LOGINS = {
  claude: {
    label: "Claude Code",
    provider: "Anthropic",
    gatewayProvider: "anthropic",
    hosts: ["api.anthropic.com", "platform.claude.com"],
    apiHost: "api.anthropic.com",
  },
  codex: {
    label: "Codex",
    provider: "OpenAI",
    gatewayProvider: "openai",
    hosts: ["chatgpt.com", "auth.openai.com"],
    apiHost: "api.openai.com",
  },
} as const satisfies Partial<
  Record<
    Harness,
    {
      readonly label: string;
      readonly provider: string;
      readonly gatewayProvider: GatewayLlmProvider;
      readonly hosts: ReadonlyArray<string>;
      readonly apiHost: string;
    }
  >
>;

/** A harness that can use a login, the Gateway's credential, or an API key. */
export type LoginHarness = keyof typeof LOGINS;

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
 * Probes a brain on a Worker behind a Gateway (ADR 0027). If the Gateway has the credential of
 * the harness's provider, checks only the harness binary. Otherwise, Claude Code and Codex use
 * the operator's login (ADR 0026), or an API key in the Attempt's environment if `apiKeyed`
 * returns `true` for the harness: `probe` checks the login or the binary, then the machine must
 * connect to the login's hosts, or the provider's API host, through the forward proxy. Pi goes
 * to `probe`, which rejects it on any remote machine. The checks run through `shell`, on the
 * machine or in a container on it.
 */
export const gatewayHarnessProbe = (
  commands: RemoteCommands,
  machine: SshMachine,
  gateway: MachineGateway,
  probe: HarnessProbe,
  shell: RemoteShell,
  apiKeyed: (harness: LoginHarness) => boolean,
): HarnessProbe => {
  const worker = machine.address.name;
  const host = machine.shell.destination;
  const { domain } = gateway.settings;
  const proxy = forwardProxyUrl(domain);

  /** Checks only the binary of a harness whose provider credential the Gateway holds. */
  const binaryOnly = (harness: LoginHarness) =>
    harnessBinaryProbe(
      commands,
      host,
      shell,
      harness,
      `the Gateway's ${LOGINS[harness].provider} credential`,
    );

  const loginHostsReachable = Effect.fn("SshExecutor.probeLoginHostsBehindGateway")(function* (
    harness: LoginHarness,
  ) {
    const { label } = LOGINS[harness];
    const keyed = apiKeyed(harness);
    const hosts: ReadonlyArray<string> = keyed ? [LOGINS[harness].apiHost] : LOGINS[harness].hosts;
    const uses = keyed ? "an API key" : "its login";
    const alternative = keyed
      ? `, or add ${LOGINS[harness].gatewayProvider} to the worker's llm_providers with the key on the gateway`
      : "";
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
          ? `${label} uses ${uses} on SSH worker "${worker}", and the gateway's forward proxy blocks ${loginHost}. Add ${loginHost} to the gateway's egress allowlist${alternative}.`
          : `${label} uses ${uses} on SSH worker "${worker}", which can't reach ${loginHost} through the gateway's forward proxy at ${proxy}`,
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
      case "codex":
        return gateway.settings.llmProviders.includes(LOGINS[brain.harness].gatewayProvider)
          ? binaryOnly(brain.harness)
          : loginOnMachine(brain, brain.harness);
      case "pi":
        return probe(brain);
    }
  };
};
