import type { CloudflareLlmProvider } from "@usine/core/worker";

/** The home directory of the image's `usine` user, where every command starts. */
export const SANDBOX_HOME = "/home/usine";

/** The directory with each command's process files, one directory per process ID. */
export const PROCESSES_DIRECTORY = `${SANDBOX_HOME}/.usine/processes`;

/**
 * The file that the image's init writes when the platform sends the container SIGTERM, before
 * it stops the container within 15 minutes (`image/init.sh`).
 */
export const DRAIN_MARKER = `${SANDBOX_HOME}/.usine/draining`;

/**
 * The certificate authority that signs the certificates of the hosts the Worker intercepts over
 * HTTPS. The container runtime mounts it.
 */
export const CONTAINER_CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

/**
 * The host that each provider's outbound handler serves over plain HTTP inside the sandbox, and
 * the upstream it forwards to over HTTPS.
 */
export const PROVIDER_HOSTS = {
  anthropic: { sandbox: "anthropic.usine.internal", upstream: "api.anthropic.com" },
  openai: { sandbox: "openai.usine.internal", upstream: "api.openai.com" },
} as const satisfies Record<
  CloudflareLlmProvider,
  { readonly sandbox: string; readonly upstream: string }
>;

/** The GitHub hosts whose requests the GitHub outbound handler authenticates. */
export const GITHUB_HOSTS = ["github.com", "api.github.com"] as const;
/** A GitHub host whose requests the outbound handler authenticates with the installation token. */
export type GitHubHost = (typeof GITHUB_HOSTS)[number];

/**
 * The value the sandbox sends where a tool expects a credential. The outbound handlers replace
 * it, so it's not a secret.
 */
export const PLACEHOLDER_CREDENTIAL = "usine-placeholder";

/** The variables each provider's harness needs to call its outbound handler. */
const PROVIDER_ENVIRONMENT = {
  anthropic: {
    ANTHROPIC_BASE_URL: `http://${PROVIDER_HOSTS.anthropic.sandbox}`,
    ANTHROPIC_API_KEY: PLACEHOLDER_CREDENTIAL,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  },
  openai: { OPENAI_API_KEY: PLACEHOLDER_CREDENTIAL },
} as const satisfies Record<CloudflareLlmProvider, Readonly<Record<string, string>>>;

/**
 * Returns the environment that points the harnesses, git, and gh at the outbound handlers, for
 * a sandbox whose handlers hold keys for `providers`. It contains no secret.
 *
 * - git and gh use HTTPS to GitHub, and trust the container's certificate authority, as
 *   Cloudflare's coding-agent runner sets it up. gh sends the placeholder as its token.
 * - Claude Code calls the Anthropic handler over plain HTTP with the placeholder as its key.
 * - Codex reads the placeholder from `OPENAI_API_KEY`; the image's Codex configuration points
 *   its `usine` model provider at the OpenAI handler.
 */
export const harnessEnvironment = (
  providers: ReadonlyArray<CloudflareLlmProvider>,
): Record<string, string> =>
  Object.assign(
    {
      GIT_SSL_CAINFO: CONTAINER_CA,
      CURL_CA_BUNDLE: CONTAINER_CA,
      SSL_CERT_FILE: CONTAINER_CA,
      NODE_EXTRA_CA_CERTS: CONTAINER_CA,
      GH_TOKEN: PLACEHOLDER_CREDENTIAL,
      GH_PROMPT_DISABLED: "1",
    },
    ...providers.map((provider) => PROVIDER_ENVIRONMENT[provider]),
  );
