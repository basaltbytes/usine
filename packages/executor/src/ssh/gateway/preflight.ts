import {
  type HarnessCatalog,
  type HarnessCredential,
  type HarnessDescriptor,
} from "@usine/agents/harness";
import { type RemoteHost, SSH_FAILURE } from "@usine/agents/child-host";
import type { BrainSpec, Harness } from "@usine/core/agent/brain";
import type { GatewayCredentialKind, GatewayLlmProtocol, WorkerName } from "@usine/core/worker";
import { Effect, Option, Redacted, Ref } from "effect";
import type { CommandResult } from "../../child-command.ts";
import { ExecutorOperationError, WorkerCapabilityError } from "../../executor.ts";
import type { HarnessProbe } from "../../harness-preflight.ts";
import { type RemoteCommands, sendingShell } from "../../remote/commands.ts";
import type { GatewayCredentials, MachineGateway, SshMachine } from "../model.ts";
import { forwardProxyUrl, gatewayEnvironment } from "./environment.ts";

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

const gatewayGap = (worker: WorkerName, message: string, cause: unknown) =>
  WorkerCapabilityError.make({ worker, capability: "gateway", message, cause });

/** Returns the error for an SSH transport failure, which isn't a capability gap. */
const unreachable = (host: string, command: string, result: CommandResult) =>
  ExecutorOperationError.make({
    operation: "preflight",
    message: `Can't reach ${host} to run ${command}`,
    cause: new Error(result.stderr.trim() || `ssh exited with code ${SSH_FAILURE}`),
  });

/** Each provider's display name and the Gateway variables that set its credential. */
const PROVIDER_CREDENTIALS = {
  "anthropic-messages": {
    label: "Anthropic",
    variables: "ANTHROPIC_API_KEY or USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN",
  },
  "openai-responses": {
    label: "OpenAI",
    variables: "OPENAI_API_KEY or USINE_GATEWAY_CHATGPT_AUTH_FILE",
  },
} as const satisfies Record<
  GatewayLlmProtocol,
  { readonly label: string; readonly variables: string }
>;

const NO_CREDENTIALS: GatewayCredentials = {
  "anthropic-messages": Option.none(),
  "openai-responses": Option.none(),
};

/**
 * Reads the Gateway's credential kind for each provider in the Worker's `llmProviders` and
 * records them for the Worker (ADR 0013). Fails if the Gateway has no credential for a listed
 * provider or predates credential reporting.
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
    yield* Effect.logWarning("Gateway upgrade required before using LLM protocols", {
      worker,
      gateway: gateway.forward.gateway,
      llmProviders: listed,
    });
    return yield* gatewayGap(
      worker,
      `The gateway of SSH worker "${worker}" doesn't report its LLM credentials. Upgrade @usine/gateway on the gateway before using ${listed.join(", ")} in llm_providers.`,
      new Error("the gateway answered 404 for GET /v1/providers"),
    );
  }
  const { providers } = reported.value;
  const kindOf = (provider: GatewayLlmProtocol) =>
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
    "anthropic-messages": listed.includes("anthropic-messages")
      ? kindOf("anthropic-messages")
      : Option.none(),
    "openai-responses": listed.includes("openai-responses")
      ? kindOf("openai-responses")
      : Option.none(),
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
  catalog: HarnessCatalog,
  gateway: MachineGateway,
  harness: Harness,
): Effect.Effect<Option.Option<GatewayCredentialKind>> =>
  Effect.map(Ref.get(gateway.credentials), (credentials) =>
    Option.flatMap(catalog.get(harness), (descriptor) =>
      Option.flatMap(descriptor.worker.credential, ({ protocol }) => credentials[protocol]),
    ),
  );

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
    "anthropic-messages": credentialMode(
      credentials["anthropic-messages"],
      settings.llmProviders.includes("anthropic-messages"),
    ),
    "openai-responses": credentialMode(
      credentials["openai-responses"],
      settings.llmProviders.includes("openai-responses"),
    ),
    attachments: attachments.filter((attachment) => attachment.worker === worker).length,
  });
});

/**
 * Verifies the Gateway from an SSH Worker's machine without attaching anything: the machine
 * receives the caller-token variables, and the machine can connect to `git.<domain>`, which
 * rejects a request without a caller token.
 */
const verifyGatewayFromMachine = Effect.fn("SshExecutor.verifyGatewayFromMachine")(function* (
  catalog: HarnessCatalog,
  commands: RemoteCommands,
  worker: WorkerName,
  machine: SshMachine,
  gateway: MachineGateway,
) {
  const { forward, settings } = gateway;
  const gitHost = `git.${settings.domain}`;
  yield* Effect.annotateCurrentSpan({ worker, domain: settings.domain, gateway: forward.gateway });
  const environment = {
    catalog,
    domain: settings.domain,
    llmProviders: settings.llmProviders,
    ghConfigDirectory: machine.workerDirectory,
    homes: {},
    callerToken: PROBE_TOKEN,
  };
  const { sent: baseSent } = gatewayEnvironment({ ...environment, harness: Option.none() });
  const sent = {
    ...baseSent,
    ...Object.fromEntries(
      catalog.ids.flatMap((harness) =>
        Object.entries(gatewayEnvironment({ ...environment, harness: Option.some(harness) }).sent),
      ),
    ),
  };
  const received = yield* commands.inspect("preflight", sendingShell(machine.shell, sent), "sh", [
    "-c",
    SENT_VARIABLES_SCRIPT,
    "sh",
    ...Object.entries(sent).flatMap(([name, value]) => [name, Redacted.value(value)]),
  ]);
  if (received.exitCode === SSH_FAILURE)
    return yield* unreachable(machine.shell.destination, "sh", received);
  const dropped =
    received.exitCode === 0
      ? received.stdout.split("\n").filter((name) => name !== "")
      : Object.keys(sent);
  if (dropped.length > 0)
    return yield* gatewayGap(
      worker,
      `SSH worker "${worker}" doesn't receive ${dropped.join(", ")} over standard input. Its SSH commands must run in a POSIX sh with base64.`,
      new Error(
        received.stderr.trim() ||
          `variables not received: ${dropped.join(" ")} (exit code ${String(received.exitCode)})`,
      ),
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
  catalog: HarnessCatalog,
  commands: RemoteCommands,
  worker: WorkerName,
  machine: SshMachine,
  gateway: MachineGateway,
) =>
  verifyGatewayAdmin(worker, gateway).pipe(
    Effect.andThen(verifyGatewayFromMachine(catalog, commands, worker, machine, gateway)),
  );

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
  catalog: HarnessCatalog,
  commands: RemoteCommands,
  machine: SshMachine,
  gateway: MachineGateway,
  probe: HarnessProbe,
  shell: RemoteHost,
  apiKeyed: (harness: Harness) => boolean,
  external: HarnessProbe,
): HarnessProbe => {
  const worker = machine.address.name;
  const host = machine.shell.destination;
  const { domain } = gateway.settings;
  const proxy = forwardProxyUrl(domain);

  const loginHostsReachable = Effect.fn("SshExecutor.probeLoginHostsBehindGateway")(function* (
    descriptor: HarnessDescriptor,
    credential: HarnessCredential,
  ) {
    const { id: harness, label } = descriptor;
    const keyed = apiKeyed(harness);
    const hosts: ReadonlyArray<string> = keyed ? [credential.apiHost] : credential.hosts;
    const uses = keyed ? "an API key" : "its login";
    const alternative = keyed
      ? `, or add ${credential.protocol} to the worker's llm_providers with the key on the gateway`
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
    descriptor: HarnessDescriptor,
    credential: HarnessCredential,
    login: Parameters<HarnessProbe>[1],
  ) {
    const harness = descriptor.id;
    yield* Effect.annotateCurrentSpan({ worker, host, domain, harness });
    const readiness = yield* probe(brain, login);
    if (readiness._tag === "HarnessUnavailableError") return readiness;
    if (gateway.settings.egress === "proxy") yield* loginHostsReachable(descriptor, credential);
    return readiness;
  });

  return (brain, login) =>
    Option.match(
      Option.flatMap(catalog.get(brain.harness), (descriptor) =>
        Option.map(descriptor.worker.credential, (credential) => ({ descriptor, credential })),
      ),
      {
        onNone: () => probe(brain, login),
        onSome: ({ descriptor, credential }) =>
          gateway.settings.llmProviders.includes(credential.protocol)
            ? external(brain, login)
            : loginOnMachine(brain, descriptor, credential, login),
      },
    );
};
