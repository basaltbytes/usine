import type { RepositoryName } from "@usine/core/repository";
import type { GatewayDomain, GatewayLlmProvider } from "@usine/core/worker";
import { type CallerToken, GATEWAY_TOKEN_HEADER } from "@usine/gateway/admin";
import { Redacted } from "effect";

/** The directory of the Unix socket that gh reaches the Gateway through. */
export const GH_GATEWAY_SOCKET_DIRECTORY = "/run/usine-gateway";

/**
 * The Unix socket that systemd forwards to the Gateway's port 80
 * (`infra/hetzner/gateway/worker-cloud-init.yaml`). gh sends plain HTTP over it, and only HTTPS
 * to `GH_HOST` directly.
 */
const GH_GATEWAY_SOCKET = `${GH_GATEWAY_SOCKET_DIRECTORY}/http.sock`;

const FORWARD_PROXY_PORT = 3128;

/** The variable that Codex's `model_provider` reads the caller token from (`env_key`). */
const CODEX_TOKEN_VARIABLE = "USINE_GATEWAY_TOKEN";

/** The variables sent through the SSH connection because they contain the caller token. The Worker's sshd must accept each in `AcceptEnv`. */
export const GATEWAY_SENT_VARIABLES = [
  "GIT_CONFIG_VALUE_0",
  "GH_ENTERPRISE_TOKEN",
  "GH_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  CODEX_TOKEN_VARIABLE,
] as const;

/** Returns the Gateway's forward proxy URL from a Worker; children receive it as `HTTPS_PROXY`. */
export const forwardProxyUrl = (domain: GatewayDomain): string =>
  `http://${domain}:${FORWARD_PROXY_PORT}`;

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

/**
 * Returns Codex's `config.toml` for the Gateway at `domain`: a `model_provider` that sends the
 * Responses API to `llm.<domain>/openai/v1` with the caller token from `USINE_GATEWAY_TOKEN` as
 * the bearer token, and needs no login. The file contains no token.
 */
const codexGatewayConfig = (domain: GatewayDomain): string =>
  [
    'model_provider = "usine-gateway"',
    "",
    "[model_providers.usine-gateway]",
    'name = "usine gateway"',
    `base_url = "http://llm.${domain}/openai/v1"`,
    `env_key = "${CODEX_TOKEN_VARIABLE}"`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n");

export interface GatewayEnvironmentOptions {
  readonly egress?: "proxy" | "direct";
  readonly domain: GatewayDomain;
  readonly llmProviders: ReadonlyArray<GatewayLlmProvider>;
  /** The machine directory that contains the `ghGatewayConfig` files. */
  readonly ghConfigDirectory: string;
  /** The Attempt's machine directory that Codex uses as `CODEX_HOME` if the Gateway holds the OpenAI credential. */
  readonly codexHome: string;
  readonly callerToken: CallerToken;
}

/**
 * Returns the configuration files that the executor writes on the machine before an Attempt,
 * keyed by path: gh's files, and Codex's `config.toml` if the Gateway holds the OpenAI
 * credential. None contains a token.
 */
export const gatewayConfigFiles = (
  options: Omit<GatewayEnvironmentOptions, "callerToken">,
): ReadonlyArray<readonly [path: string, contents: string]> => {
  const gh = ghGatewayConfig(options.domain);
  return [
    [`${options.ghConfigDirectory}/config.yml`, gh["config.yml"]],
    [`${options.ghConfigDirectory}/hosts.yml`, gh["hosts.yml"]],
    ...(options.llmProviders.includes("openai")
      ? [[`${options.codexHome}/config.toml`, codexGatewayConfig(options.domain)] as const]
      : []),
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

/**
 * Returns the variables of `gatewayEnvironment` without a caller token or Codex's home, which
 * only an Attempt has, for commands that reach the Gateway's forward proxy but no attachment,
 * such as a preflight's harness probes.
 */
export const gatewayExportedEnvironment = (
  settings: Pick<GatewayEnvironmentOptions, "domain" | "llmProviders" | "egress">,
  ghConfigDirectory: string,
): Readonly<Record<string, string>> => {
  const { CODEX_HOME: _, ...exported } = gatewayEnvironment({
    ...settings,
    ghConfigDirectory,
    codexHome: "",
    callerToken: Redacted.make(""),
  }).exported;
  return exported;
};

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
 * - Claude Code calls `llm.<domain>/anthropic` with the caller token if the Gateway has the
 *   Anthropic credential.
 * - Codex reads `codexGatewayConfig` from `CODEX_HOME` and calls `llm.<domain>/openai/v1` with
 *   the caller token if the Gateway has the OpenAI credential.
 * - A harness whose provider the Gateway has no credential for uses its own login through the
 *   forward proxy, whose allowlist must include the login's hosts.
 */
export const gatewayEnvironment = (options: GatewayEnvironmentOptions): GatewayEnvironment => {
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
  const harnesses = options.llmProviders.map((provider) => harnessVariables(provider, options));
  return {
    exported: {
      ...exported,
      ...Object.fromEntries(harnesses.flatMap(({ exported }) => Object.entries(exported))),
    },
    sent: {
      ...sent,
      ...Object.fromEntries(harnesses.map(({ token }) => [token, callerToken] as const)),
    },
  };
};

/** The variables that point a provider's harness at the Gateway. */
interface HarnessVariables {
  readonly exported: Readonly<Record<string, string>>;
  /** The variable that carries the caller token; it's sent, never exported. */
  readonly token: (typeof GATEWAY_SENT_VARIABLES)[number];
}

/** Returns the variables that point `provider`'s harness at the Gateway. */
const harnessVariables = (
  provider: GatewayLlmProvider,
  options: Pick<GatewayEnvironmentOptions, "domain" | "codexHome">,
): HarnessVariables => {
  switch (provider) {
    case "anthropic":
      return {
        exported: { ANTHROPIC_BASE_URL: `http://llm.${options.domain}/anthropic` },
        token: "ANTHROPIC_AUTH_TOKEN",
      };
    case "openai":
      return { exported: { CODEX_HOME: options.codexHome }, token: CODEX_TOKEN_VARIABLE };
  }
};
