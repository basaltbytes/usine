import type { Harness } from "@usine/core/agent/brain";
import type { ModelProviderId } from "@usine/core/agent/provider";
import { catalog } from "@usine/agents/harness";
import { Option } from "effect";

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
 * Returns the host that the outbound handler of the provider with ID `provider` serves over plain
 * HTTP inside the sandbox, such as `anthropic.usine.internal`.
 */
export const sandboxHost = (provider: ModelProviderId): string => `${provider}.usine.internal`;

/** The GitHub hosts whose requests the GitHub outbound handler authenticates. */
export const GITHUB_HOSTS = ["github.com", "api.github.com"] as const;
/** A GitHub host whose requests the outbound handler authenticates with the installation token. */
export type GitHubHost = (typeof GITHUB_HOSTS)[number];

/**
 * The value the sandbox sends where a tool expects a credential. The outbound handlers replace
 * it, so it's not a secret.
 */
export const PLACEHOLDER_CREDENTIAL = "usine-placeholder";

/**
 * Returns the environment that points the harnesses, git, and gh at the outbound handlers, for
 * a sandbox whose handlers hold keys for `providers`. It contains no secret.
 *
 * - git and gh use HTTPS to GitHub, and trust the container's certificate authority, as
 *   Cloudflare's coding-agent runner sets it up. gh sends the placeholder as its token.
 * - A harness calls the handler of the first of its providers that the sandbox holds a key for,
 *   over plain HTTP with the placeholder as its key. Its base URL is the handler's host and the
 *   path of its gateway wiring, so the handler serves the provider's routes as the gateway does.
 * - Codex reads the placeholder from `OPENAI_API_KEY`; the image's Codex configuration points
 *   its `usine` model provider at the OpenAI handler.
 */
export const harnessEnvironment = (
  providers: ReadonlyArray<ModelProviderId>,
  harness: Option.Option<Harness>,
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
    ...catalog.descriptors
      .filter(({ id }) => Option.contains(harness, id))
      .flatMap(({ worker, providers: usable }) =>
        Option.toArray(worker.credential).flatMap(({ cloudflare, slotPath }) => {
          const provider = usable.find(({ id }) => providers.includes(id));
          return provider === undefined
            ? []
            : [
                {
                  ...cloudflare.render(`http://${sandboxHost(provider.id)}${slotPath}`, "")
                    .environment,
                  [cloudflare.tokenVariable]: PLACEHOLDER_CREDENTIAL,
                },
              ];
        }),
      ),
  );
