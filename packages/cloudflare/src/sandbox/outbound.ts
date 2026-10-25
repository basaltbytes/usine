import type { CloudflareLlmProvider } from "@usine/core/worker";
import { Match, Redacted } from "effect";
import type { ProviderCredential, SandboxCredentials } from "../api/api.ts";
import { GITHUB_HOSTS, type GitHubHost, PROVIDER_HOSTS } from "../api/harness.ts";

/** GitHub requests over HTTPS, with the Attempt's installation token added. */
interface GitHubInterception {
  readonly _tag: "GitHub";
  readonly host: GitHubHost;
  readonly token: Redacted.Redacted<string>;
}

/** Plain HTTP requests to a provider's sandbox host, forwarded to the provider over HTTPS. */
interface ProviderInterception {
  readonly _tag: "Provider";
  readonly host: string;
  readonly provider: CloudflareLlmProvider;
  readonly credential: ProviderCredential;
}

/** HTTPS requests to an allowlisted host, such as a package registry, forwarded unchanged. */
interface AllowedInterception {
  readonly _tag: "Allowed";
  readonly host: string;
}

/** One host whose container traffic goes to an outbound handler instead of the internet. */
export type Interception = GitHubInterception | ProviderInterception | AllowedInterception;

/**
 * Returns the hosts a sandbox reaches: GitHub and the providers with the Attempt's credentials,
 * and `allowedHosts` unchanged. The container has no other way out. GitHub and provider hosts
 * are never treated as allowlisted, so no request reaches them without a credential.
 */
export const interceptionsFor = (
  credentials: SandboxCredentials,
  allowedHosts: ReadonlyArray<string>,
): ReadonlyArray<Interception> => {
  const reserved = new Set<string>([
    ...GITHUB_HOSTS,
    ...Object.values(PROVIDER_HOSTS).map(({ sandbox }) => sandbox),
  ]);
  return [
    ...GITHUB_HOSTS.map((host): Interception => ({
      _tag: "GitHub",
      host,
      token: credentials.github,
    })),
    ...credentials.providers.map(({ provider, credential }): Interception => ({
      _tag: "Provider",
      host: PROVIDER_HOSTS[provider].sandbox,
      provider,
      credential,
    })),
    ...[...new Set(allowedHosts)]
      .filter((host) => !reserved.has(host))
      .map((host): Interception => ({ _tag: "Allowed", host })),
  ];
};

/** Returns the hosts in a comma-separated `ALLOWED_HOSTS` value, lowercased, without blanks. */
export const allowedHostsOf = (value: string): ReadonlyArray<string> =>
  value
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== "");

/** The headers a tool in the sandbox can use to send a credential. All are replaced. */
const CREDENTIAL_HEADERS = ["authorization", "x-api-key", "proxy-authorization"] as const;

const withoutCredentials = (request: Request): Headers => {
  const headers = new Headers(request.headers);
  for (const name of CREDENTIAL_HEADERS) headers.delete(name);
  return headers;
};

/**
 * Returns `request` with the installation token in place of any credential the sandbox sent:
 * HTTP basic authentication for git on `github.com`, and a token for the REST and GraphQL API
 * on `api.github.com`.
 */
export const gitHubRequest = (
  request: Request,
  host: GitHubHost,
  token: Redacted.Redacted<string>,
): Request => {
  const headers = withoutCredentials(request);
  const value = Redacted.value(token);
  headers.set(
    "authorization",
    host === "github.com" ? `Basic ${btoa(`x-access-token:${value}`)}` : `token ${value}`,
  );
  return new Request(request, { headers });
};

/**
 * Returns `request`, sent over plain HTTP to the provider's sandbox host, for the provider's
 * upstream over HTTPS with the provider credential in place of the sandbox's placeholder.
 */
export const providerRequest = (
  request: Request,
  provider: CloudflareLlmProvider,
  credential: ProviderCredential,
): Request => {
  const incoming = new URL(request.url);
  const upstream = new URL(
    `${incoming.pathname}${incoming.search}`,
    `https://${PROVIDER_HOSTS[provider].upstream}`,
  );
  const headers = withoutCredentials(request);
  headers.delete("host");
  Match.valueTags(credential, {
    ApiKey: ({ key }) => {
      switch (provider) {
        case "anthropic":
          headers.set("x-api-key", Redacted.value(key));
          return;
        case "openai":
          headers.set("authorization", `Bearer ${Redacted.value(key)}`);
          return;
      }
    },
  });
  return new Request(upstream, new Request(request, { headers }));
};
