import type { RepositoryName } from "@usine/core/repository";
import type { GatewayDomain, GatewayLlmProvider } from "@usine/core/worker";
import { type CallerToken, GATEWAY_TOKEN_HEADER } from "@usine/gateway/admin";
import { Redacted } from "effect";

/**
 * The Unix socket on a Worker behind a Gateway that systemd forwards to the
 * Gateway's port 80 (`infra/hetzner/gateway/worker-cloud-init.yaml`). gh
 * sends plain HTTP over it; to `GH_HOST` itself it sends only HTTPS.
 */
const GH_GATEWAY_SOCKET = "/run/usine-gateway/http.sock";

/** The port of the Gateway's forward proxy. */
const FORWARD_PROXY_PORT = 3128;

/**
 * The variables an Attempt behind a Gateway receives through the SSH
 * connection, because their values contain its caller token. The Worker's
 * sshd must accept each of them with `AcceptEnv`.
 */
export const GATEWAY_SENT_VARIABLES = [
  "GIT_CONFIG_VALUE_0",
  "GH_ENTERPRISE_TOKEN",
  "GH_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
] as const;

/** Where a Worker behind the Gateway at `domain` clones and fetches `repository`. */
export const gatewayRepositoryUrl = (domain: GatewayDomain, repository: RepositoryName): string =>
  `http://git.${domain}/${repository}.git`;

/**
 * The files of gh's configuration directory on a Worker behind the Gateway
 * at `domain`: requests go through the Gateway's socket, and `git.<domain>`
 * is a known host. Neither file contains a token; gh reads the caller token
 * from `GH_ENTERPRISE_TOKEN` and `GH_TOKEN`.
 */
export const ghGatewayConfig = (domain: GatewayDomain) =>
  ({
    "config.yml": `version: "1"\nhttp_unix_socket: ${GH_GATEWAY_SOCKET}\n`,
    "hosts.yml": `git.${domain}:\n    git_protocol: https\n`,
  }) as const;

/** What a Worker's Attempt needs to reach GitHub and its LLM providers through its Gateway. */
export interface GatewayEnvironmentOptions {
  readonly domain: GatewayDomain;
  readonly llmProviders: ReadonlyArray<GatewayLlmProvider>;
  /** The directory on the machine that contains `ghGatewayConfig`'s files. */
  readonly ghConfigDirectory: string;
  readonly callerToken: CallerToken;
}

/**
 * An Attempt's environment behind a Gateway. `exported` contains no secret
 * and is exported in each command line. `sent` contains the caller token
 * wherever a tool expects its credential and reaches the machine through the
 * SSH connection, never in a command line.
 */
export interface GatewayEnvironment {
  readonly exported: Readonly<Record<string, string>>;
  readonly sent: Readonly<Record<string, Redacted.Redacted<string>>>;
}

/**
 * Points git, gh, package managers, and Claude Code (when the Gateway holds
 * the Anthropic credential) at the Gateway at `domain`:
 *
 * - git sends the caller token in `x-usine-gateway-token` to `git.<domain>`
 *   only, and rewrites `https://github.com/` and `https://git.<domain>/` to
 *   the Gateway, so a push to a github.com remote or a URL gh builds goes
 *   there too. The header value is configuration entry 0, so it travels in
 *   `GIT_CONFIG_VALUE_0`.
 * - gh uses `git.<domain>` as its host through the Gateway's socket, with
 *   the caller token as both its enterprise and GitHub token, so absolute
 *   pagination links and github.com URLs authenticate through the socket too.
 * - Package managers use the forward proxy at `<domain>:3128`; local
 *   addresses and the Gateway's own names go direct.
 * - Claude Code calls `llm.<domain>/anthropic` with the caller token when
 *   the Gateway holds the Anthropic credential. Without it, and for Codex
 *   (#244), nothing is set here: preflight refuses the brain, since the
 *   harness would have no route to its provider from behind the Gateway
 *   (`gatewayHarnessProbe`).
 */
export const gatewayEnvironment = (options: GatewayEnvironmentOptions): GatewayEnvironment => {
  const { domain, callerToken } = options;
  const gitBase = `http://git.${domain}/`;
  const proxy = `http://${domain}:${FORWARD_PROXY_PORT}`;
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
  if (!options.llmProviders.includes("anthropic")) return { exported, sent };
  return {
    exported: { ...exported, ANTHROPIC_BASE_URL: `http://llm.${domain}/anthropic` },
    sent: { ...sent, ANTHROPIC_AUTH_TOKEN: callerToken },
  };
};
