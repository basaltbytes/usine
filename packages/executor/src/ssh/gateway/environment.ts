import type { Harness } from "@usine/core/agent/brain";
import type { HarnessCatalog } from "@usine/agents/harness";
import type { GatewaySlot, ModelProvider } from "@usine/core/agent/provider";
import type { RepositoryName } from "@usine/core/repository";
import type { GatewayDomain } from "@usine/core/worker";
import { type CallerToken, GATEWAY_TOKEN_HEADER } from "@usine/gateway/admin";
import { Option, Redacted, Schema } from "effect";

/** The directory of the Unix socket that gh reaches the Gateway through. */
export const GH_GATEWAY_SOCKET_DIRECTORY = "/run/usine-gateway";

/**
 * The Unix socket that systemd forwards to the Gateway's port 80
 * (`infra/hetzner/gateway/worker-cloud-init.yaml`). gh sends plain HTTP over it, and only HTTPS
 * to `GH_HOST` directly.
 */
const GH_GATEWAY_SOCKET = `${GH_GATEWAY_SOCKET_DIRECTORY}/http.sock`;

const FORWARD_PROXY_PORT = 3128;

/** Returns the Gateway's forward proxy URL from a Worker; children receive it as `HTTPS_PROXY`. */
export const forwardProxyUrl = (domain: GatewayDomain): string =>
  `http://${domain}:${FORWARD_PROXY_PORT}`;

/**
 * The path prefixes a Gateway serves on `llm.<domain>`: provider slots such as
 * `/openai-responses`, or the provider IDs such as `/openai` of a Gateway from before slots, which
 * reports its providers by the same names.
 */
export const GatewayLlmPrefixes = Schema.Literals(["slot", "provider"]);
export type GatewayLlmPrefixes = typeof GatewayLlmPrefixes.Type;

/** Returns the `llm.<domain>` path prefix of `provider` on a Gateway that serves `prefixes`. */
export const llmPrefixOf = (provider: ModelProvider, prefixes: GatewayLlmPrefixes): string =>
  prefixes === "slot" ? provider.slot : provider.id;

/** Returns the URL a Worker behind the Gateway clones and fetches `repository` from. */
export const gatewayRepositoryUrl = (domain: GatewayDomain, repository: RepositoryName): string =>
  `http://git.${domain}/${repository}.git`;

/**
 * Returns gh's configuration files for the Gateway at `domain`. Neither file contains a token;
 * gh reads the caller token from `GH_ENTERPRISE_TOKEN` and `GH_TOKEN`.
 */
export const ghGatewayConfig = (domain: GatewayDomain) =>
  ({
    "config.yml": `version: "1"\nhttp_unix_socket: ${GH_GATEWAY_SOCKET}\n`,
    "hosts.yml": `git.${domain}:\n    git_protocol: https\n`,
  }) as const;

export interface GatewayEnvironmentOptions {
  readonly catalog: HarnessCatalog;
  readonly egress?: "proxy" | "direct";
  readonly domain: GatewayDomain;
  readonly llmProviders: ReadonlyArray<GatewaySlot>;
  /** The path prefixes the Gateway serves on `llm.<domain>`, from the last preflight. */
  readonly llmPrefixes: GatewayLlmPrefixes;
  /** The machine directory that contains the `ghGatewayConfig` files. */
  readonly ghConfigDirectory: string;
  /** Attempt home directories indexed by harness ID. */
  readonly homes: Readonly<Record<string, string>>;
  readonly callerToken: CallerToken;
}

/**
 * Returns the configuration files that the executor writes on the machine before an Attempt,
 * keyed by path: gh's files, and each harness's files, such as Codex's `config.toml`, if the
 * Gateway holds one of the harness's providers. None contains a token.
 */
export const gatewayConfigFiles = (
  options: Omit<GatewayEnvironmentOptions, "callerToken">,
): ReadonlyArray<readonly [path: string, contents: string]> => {
  const gh = ghGatewayConfig(options.domain);
  return [
    [`${options.ghConfigDirectory}/config.yml`, gh["config.yml"]],
    [`${options.ghConfigDirectory}/hosts.yml`, gh["hosts.yml"]],
    ...gatewayWirings(options).flatMap(({ files }) => files),
  ];
};

/**
 * An Attempt's environment behind a Gateway. `exported` has no secrets and goes in each command
 * line; `sent` contains the caller token and goes only through the SSH connection.
 */
export interface GatewayEnvironment {
  readonly exported: Readonly<Record<string, string>>;
  readonly sent: Readonly<Record<string, Redacted.Redacted<string>>>;
}

/** Returns the base proxy, git, and gh environment for commands without a harness. */
export const gatewayExportedEnvironment = (
  settings: Pick<GatewayEnvironmentOptions, "catalog" | "domain" | "llmProviders" | "egress">,
  ghConfigDirectory: string,
): Readonly<Record<string, string>> =>
  gatewayEnvironment({
    ...settings,
    // Without a harness, the environment has no LLM URL.
    llmPrefixes: "slot",
    harness: Option.none(),
    ghConfigDirectory,
    homes: {},
    callerToken: Redacted.make(""),
  }).exported;

/**
 * Returns the environment that points git, gh, package managers, and Claude Code at the
 * Gateway at `domain`.
 *
 * - git sends the caller token in `x-usine-gateway-token` to `git.<domain>` only, and rewrites
 *   `https://github.com/` and `https://git.<domain>/` to the Gateway. The header value is
 *   config entry 0 (`GIT_CONFIG_VALUE_0`).
 * - gh uses `git.<domain>` through the Gateway socket, with the caller token as both its
 *   enterprise and GitHub token, so absolute pagination links also authenticate.
 * - Package managers use the forward proxy at `<domain>:3128`; local addresses and the
 *   Gateway's own names bypass it.
 * - A harness whose provider the Gateway holds calls `llm.<domain>/<slot>` and its slot path
 *   with the caller token, wired as its descriptor says: Claude Code calls
 *   `llm.<domain>/anthropic-messages`, and Codex reads `CODEX_HOME` and calls
 *   `llm.<domain>/openai-responses/v1`. A harness that runs models of several providers gets the
 *   URL of each slot that the Gateway holds in that provider's variable: OpenCode reads
 *   `llm.<domain>/opencode-go` for a model of OpenCode Go.
 * - A Gateway from before slots gets the provider IDs instead, such as `/anthropic`.
 * - A harness whose providers the Gateway has no credential for uses its own login through the
 *   forward proxy, whose allowlist must include the login's hosts.
 */
export const gatewayEnvironment = (
  options: GatewayEnvironmentOptions & { readonly harness: Option.Option<Harness> },
): GatewayEnvironment => {
  const { domain, callerToken } = options;
  const gitBase = `http://git.${domain}/`;
  const proxy = options.egress === "direct" ? "" : forwardProxyUrl(domain);
  const direct = `localhost,127.0.0.1,::1,${domain}`;
  const exported = {
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: `http.${gitBase}.extraHeader`,
    GIT_CONFIG_KEY_1: `url.${gitBase}.insteadOf`,
    GIT_CONFIG_VALUE_1: "https://github.com/",
    GIT_CONFIG_KEY_2: `url.${gitBase}.insteadOf`,
    GIT_CONFIG_VALUE_2: `https://git.${domain}/`,
    GH_HOST: `git.${domain}`,
    GH_CONFIG_DIR: options.ghConfigDirectory,
    GH_PROMPT_DISABLED: "1",
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    https_proxy: proxy,
    http_proxy: proxy,
    NO_PROXY: direct,
    no_proxy: direct,
  };
  const sent = {
    GIT_CONFIG_VALUE_0: Redacted.make(`${GATEWAY_TOKEN_HEADER}: ${Redacted.value(callerToken)}`),
    GH_ENTERPRISE_TOKEN: callerToken,
    GH_TOKEN: callerToken,
  };
  const harnesses = gatewayWirings(options).filter(({ harness }) =>
    Option.contains(options.harness, harness),
  );
  return {
    exported: {
      ...exported,
      ...Object.fromEntries(harnesses.flatMap(({ environment }) => Object.entries(environment))),
    },
    sent: {
      ...sent,
      ...Object.fromEntries(
        harnesses.map(({ tokenVariable }) => [tokenVariable, callerToken] as const),
      ),
    },
  };
};

/** The registered wiring recipes of the harnesses whose providers the gateway holds. */
const gatewayWirings = (
  options: Pick<
    GatewayEnvironmentOptions,
    "catalog" | "domain" | "llmProviders" | "llmPrefixes" | "homes"
  >,
) =>
  options.catalog.descriptors.flatMap(({ id, worker, providers }) =>
    Option.toArray(worker.credential).flatMap((credential) =>
      Option.toArray(options.catalog.gatewayProvider(id, options.llmProviders)).map((first) => {
        const slotUrl = (provider: ModelProvider, path: string) =>
          `http://llm.${options.domain}/${llmPrefixOf(provider, options.llmPrefixes)}${path}`;
        const rendered = credential.gateway.render(
          slotUrl(first, credential.slotPath),
          options.homes[id] ?? "",
        );
        const held = providers.filter(({ slot }) => options.llmProviders.includes(slot));
        return {
          harness: id,
          ...rendered,
          environment: {
            ...rendered.environment,
            ...credential.slotEnvironment(held, slotUrl),
          },
        };
      }),
    ),
  );
