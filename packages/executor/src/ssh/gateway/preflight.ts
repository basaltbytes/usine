import {
  type HarnessCatalog,
  type HarnessCredential,
  type HarnessDescriptor,
} from "@usine/agents/harness";
import type { RemoteHost } from "@usine/agents/child-host";
import type { BrainSpec, Harness } from "@usine/core/agent/brain";
import type { ModelProvider, ModelProviderCatalog } from "@usine/core/agent/provider";
import type { GatewayCredentialKind, WorkerName } from "@usine/core/worker";
import { Effect, Option, Redacted, Ref } from "effect";
import { WorkerCapabilityError } from "../../executor.ts";
import type { HarnessProbe } from "../../harness-preflight.ts";
import { type RemoteCommands, sendingShell } from "../../remote/commands.ts";
import type { GatewayCredentials, MachineGateway, SshMachine } from "../model.ts";
import { type ReportedProviders, reportedProviders } from "./admin.ts";
import {
  forwardProxyUrl,
  gatewayEnvironment,
  type GatewayLlmPrefixes,
  llmPrefixOf,
} from "./environment.ts";

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

/** Returns `items` as an English list, such as `a, b, and c`. */
const listed = (items: ReadonlyArray<string>): string =>
  items.length <= 2
    ? items.join(" and ")
    : `${items.slice(0, -1).join(", ")}, and ${items.at(-1) ?? ""}`;

/**
 * The `llm.<domain>` path prefixes of `providers` on a Gateway that serves `prefixes`, for
 * messages. With `renamed`, only those of the providers whose slot isn't their ID, which a Gateway
 * from before slots serves at another prefix.
 */
const llmPaths = (providers: ModelProviderCatalog, prefixes: GatewayLlmPrefixes, renamed = false) =>
  listed(
    providers.providers
      .filter(
        (provider) =>
          !renamed || llmPrefixOf(provider, "provider") !== llmPrefixOf(provider, "slot"),
      )
      .map((provider) => `/${llmPrefixOf(provider, prefixes)}`),
  );

/**
 * Records the path prefixes the Gateway serves, which Attempts that start later use. Logs a
 * warning when the Gateway turns out to predate protocol prefixes, and once it serves them again.
 */
const recordLlmPrefixes = Effect.fn("SshExecutor.recordLlmPrefixes")(function* (
  providers: ModelProviderCatalog,
  worker: WorkerName,
  gateway: MachineGateway,
  prefixes: GatewayLlmPrefixes,
) {
  const fields = {
    worker,
    gateway: gateway.forward.gateway,
    llmPrefixes: prefixes,
    paths: llmPaths(providers, prefixes),
  };
  yield* Effect.annotateCurrentSpan(fields);
  const previous = yield* Ref.getAndSet(gateway.llmPrefixes, prefixes);
  if (previous === prefixes)
    return yield* Effect.logDebug("The Gateway serves the same LLM path prefixes", fields);
  if (prefixes === "provider")
    return yield* Effect.logWarning(
      "The Gateway predates protocol path prefixes; Attempts use its provider prefixes until @usine/gateway is upgraded on it",
      fields,
    );
  yield* Effect.logInfo("The Gateway serves protocol path prefixes; Attempts use them", fields);
});

/**
 * Returns why the Gateway can't serve `provider` to the Worker: it doesn't serve the provider's
 * slot or one of its routes, or holds no credential for it. A Gateway from before the provider
 * catalog reports no slots, so only its credentials are checked.
 */
const providerGap = (
  worker: WorkerName,
  gateway: MachineGateway,
  reported: ReportedProviders,
  provider: ModelProvider,
): Option.Option<WorkerCapabilityError> => {
  const { slot, label } = provider;
  const name = gateway.forward.gateway;
  const upgrade = "Upgrade @usine/gateway on it to the release that matches the orchestrator.";
  const unserved = Option.flatMap(reported.slots, (slots) => {
    const routes = slots[slot];
    if (routes === undefined)
      return Option.some(
        gatewayGap(
          worker,
          `Gateway ${name} doesn't serve the ${label} slot ${slot}, which the llm_providers of SSH worker "${worker}" lists, so it is older than this orchestrator. ${upgrade}`,
          new Error(`the gateway serves ${Object.keys(slots).join(", ") || "no slot"}`),
        ),
      );
    const missing = provider.routes.filter((route) => !routes.includes(route));
    return missing.length === 0
      ? Option.none()
      : Option.some(
          gatewayGap(
            worker,
            `Gateway ${name} serves the ${label} slot ${slot} without ${listed(missing)}, which this orchestrator's harnesses call. ${upgrade}`,
            new Error(`the gateway serves ${routes.join(", ")} under ${slot}`),
          ),
        );
  });
  if (Option.isSome(unserved)) return unserved;
  if (reported.credentials[slot] !== undefined) return Option.none();
  const variables = provider.credentials.map(({ variable }) => variable).join(" or ");
  const older = Option.isNone(reported.slots)
    ? ` Gateway ${name} doesn't report the slots it serves, so it is older than this orchestrator: if its release predates ${slot}, upgrade @usine/gateway on it first.`
    : "";
  return Option.some(
    gatewayGap(
      worker,
      `The gateway of SSH worker "${worker}" has no ${label} credential, but the worker's llm_providers includes ${slot}. Set ${variables} on the gateway, or remove ${slot} from llm_providers.${older}`,
      new Error(
        `the gateway reports ${Object.keys(reported.credentials).join(", ") || "no provider"}`,
      ),
    ),
  );
};

/**
 * Reads the Gateway's provider report for the slots in the Worker's `llmProviders`, and records
 * each credential kind for the Worker (ADR 0013), with the path prefixes the Gateway serves. Fails
 * if the Gateway doesn't serve a listed provider's slot and routes, has no credential for it, or
 * predates credential reporting. Returns the report, or `None` if `llmProviders` is empty.
 */
const recordProviderCredentials = Effect.fn("SshExecutor.recordProviderCredentials")(function* (
  catalog: HarnessCatalog,
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
    yield* Ref.set(gateway.credentials, {});
    return Option.none<ReportedProviders>();
  }
  const report = yield* gateway.admin.providers.pipe(
    Effect.mapError((error) => gatewayGap(worker, error.message, error)),
  );
  if (Option.isNone(report)) {
    yield* Effect.logWarning("Gateway upgrade required before using LLM providers", {
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
  const providers = catalog.providers;
  const reported = reportedProviders(providers, report.value);
  yield* recordLlmPrefixes(providers, worker, gateway, reported.prefixes);
  for (const slot of listed) {
    const gap = Option.flatMap(providers.find(slot), (provider) =>
      providerGap(worker, gateway, reported, provider),
    );
    if (Option.isSome(gap)) return yield* gap.value;
  }
  const credentials: GatewayCredentials = Object.fromEntries(
    listed.flatMap((slot) => {
      const kind = reported.credentials[slot];
      return kind === undefined ? [] : [[slot, kind] as const];
    }),
  );
  yield* Ref.set(gateway.credentials, credentials);
  return Option.some(reported);
});

/** Returns how a provider's harness authenticates on the Worker, for log lines. */
const credentialMode = (kind: GatewayCredentialKind | undefined, listed: boolean) =>
  kind === undefined ? (listed ? "gateway-unreported" : "worker-login") : `gateway-${kind}`;

/**
 * Returns the credential kind the Gateway injects for `harness`, as recorded by the last
 * preflight: the kind of the harness's provider that the Gateway holds. Pi uses its own login.
 */
export const gatewayCredentialFor = (
  catalog: HarnessCatalog,
  gateway: MachineGateway,
  harness: Harness,
): Effect.Effect<Option.Option<GatewayCredentialKind>> =>
  Effect.map(Ref.get(gateway.credentials), (credentials) =>
    Option.flatMap(catalog.gatewayProvider(harness, gateway.settings.llmProviders), ({ slot }) =>
      Option.fromUndefinedOr(credentials[slot]),
    ),
  );

/**
 * Returns why the Gateway needs an upgrade to match the orchestrator, for operators, or `None`
 * if it serves what the orchestrator uses: slot path prefixes, which Attempts otherwise replace
 * with the older ones, a report of the slots it serves, which preflight checks each listed
 * provider against, and the provider-credentials admin API that Settings uses.
 */
const gatewayUpgradeOf = (
  providers: ModelProviderCatalog,
  gateway: MachineGateway,
  prefixes: GatewayLlmPrefixes,
  reported: Option.Option<ReportedProviders>,
  servesProviderCredentials: boolean,
): Option.Option<string> => {
  const lags = [
    ...(prefixes === "provider"
      ? [
          `it serves model requests only at ${llmPaths(providers, "provider", true)}, which attempts call instead of ${llmPaths(providers, "slot", true)}`,
        ]
      : []),
    ...(Option.exists(reported, ({ slots }) => Option.isNone(slots))
      ? ["it doesn't report the provider slots it serves, so preflight can't check their routes"]
      : []),
    ...(servesProviderCredentials
      ? []
      : ["it has no provider-credentials admin API, so Settings can't manage its provider logins"]),
  ];
  return lags.length === 0
    ? Option.none()
    : Option.some(
        `Gateway ${gateway.forward.gateway} is older than this orchestrator: ${lags.join("; ")}. Upgrade @usine/gateway on it to the release that matches the orchestrator.`,
      );
};

/**
 * Verifies the Gateway's admin API for an SSH Worker without attaching anything: the forward
 * opens and the admin API accepts the admin token. Records the Gateway's credential kind for
 * each provider in the Worker's `llmProviders`, after checking that the Gateway serves each one's
 * slot and routes, and the path prefixes it serves. Needs no Worker machine. Returns why the
 * Gateway needs an upgrade, or `None` if it matches the orchestrator.
 */
export const verifyGatewayAdmin = Effect.fn("SshExecutor.verifyGatewayAdmin")(function* (
  catalog: HarnessCatalog,
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
  const reported = yield* recordProviderCredentials(catalog, worker, gateway);
  const credentials = yield* Ref.get(gateway.credentials);
  const prefixes = yield* Ref.get(gateway.llmPrefixes);
  const servesProviderCredentials = yield* admin.servesProviderCredentials.pipe(
    Effect.mapError((error) => gatewayGap(worker, error.message, error)),
  );
  const providers = catalog.providers;
  const upgrade = gatewayUpgradeOf(
    providers,
    gateway,
    prefixes,
    reported,
    servesProviderCredentials,
  );
  yield* Effect.logInfo("SSH Worker Gateway admin API verified", {
    worker,
    domain: settings.domain,
    gateway: forward.gateway,
    adminPort: settings.adminPort,
    forwardPort: open.url.port,
    llmPrefixes: prefixes,
    servesProviderCredentials,
    upgrade: Option.getOrUndefined(upgrade),
    llmProviders: settings.llmProviders.join(","),
    ...Object.fromEntries(
      providers.slots.map((slot) => [
        slot,
        credentialMode(credentials[slot], settings.llmProviders.includes(slot)),
      ]),
    ),
    attachments: attachments.filter((attachment) => attachment.worker === worker).length,
  });
  return upgrade;
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
    llmPrefixes: yield* Ref.get(gateway.llmPrefixes),
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
  const dropped =
    received.exitCode === 0
      ? received.stdout.split("\n").filter((name) => name !== "")
      : Object.keys(sent);
  if (dropped.length > 0) {
    const stderr = received.stderr.trim();
    return yield* gatewayGap(
      worker,
      `SSH worker "${worker}" doesn't receive ${dropped.join(", ")} over standard input. Its SSH commands must run in a POSIX sh with base64.`,
      new Error(
        `variables not received: ${dropped.join(" ")} (exit code ${String(received.exitCode)})${stderr === "" ? "" : `: ${stderr}`}`,
      ),
    );
  }

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
 * Returns why the Gateway needs an upgrade, as `verifyGatewayAdmin` does.
 */
export const verifyGateway = (
  catalog: HarnessCatalog,
  commands: RemoteCommands,
  worker: WorkerName,
  machine: SshMachine,
  gateway: MachineGateway,
) =>
  verifyGatewayAdmin(catalog, worker, gateway).pipe(
    Effect.tap(() => verifyGatewayFromMachine(catalog, commands, worker, machine, gateway)),
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
 * the operator's login on the machine, or an API key in the Attempt's environment if `apiKeyed`
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
  apiKeyed: (harness: Harness) => Option.Option<ModelProvider>,
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
    const hosts: ReadonlyArray<string> = Option.match(keyed, {
      onNone: () => credential.hosts,
      onSome: (provider) => provider.hosts,
    });
    const uses = Option.isSome(keyed) ? "an API key" : "its login";
    const alternative = Option.match(keyed, {
      onNone: () => "",
      onSome: ({ slot }) =>
        `, or add ${slot} to the worker's llm_providers with the key on the gateway`,
    });
    yield* Effect.annotateCurrentSpan({ worker, host, domain, harness });
    const result = yield* commands.inspect("preflight", shell, "sh", [
      "-c",
      LOGIN_HOSTS_SCRIPT,
      "sh",
      proxy,
      ...hosts,
    ]);
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
          catalog.gatewayHolds(descriptor.id, gateway.settings.llmProviders)
            ? external(brain, login)
            : loginOnMachine(brain, descriptor, credential, login),
      },
    );
};
