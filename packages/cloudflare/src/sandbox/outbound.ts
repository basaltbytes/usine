import type { CloudflareLlmProvider } from "@usine/core/worker";
import { Match, Option, Redacted } from "effect";
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

/** Requests to a GitHub or provider host without a credential, refused with status 403. */
interface DeniedInterception {
  readonly _tag: "Denied";
  readonly host: string;
  readonly scheme: "http" | "https";
}

/** One host whose container traffic goes to an outbound handler instead of the internet. */
export type Interception =
  | GitHubInterception
  | ProviderInterception
  | AllowedInterception
  | DeniedInterception;

/**
 * Returns the hosts a sandbox reaches: GitHub and the providers with the Attempt's credentials,
 * and `allowedHosts` unchanged. The container has no other way out. GitHub and provider hosts
 * without a credential are denied rather than left out, because a running container keeps its
 * last handler for a host; they're never treated as allowlisted.
 */
export const interceptionsFor = (
  credentials: SandboxCredentials,
  allowedHosts: ReadonlyArray<string>,
): ReadonlyArray<Interception> => {
  const providerHosts = Object.values(PROVIDER_HOSTS).map(({ sandbox }) => sandbox);
  const reserved = new Set<string>([...GITHUB_HOSTS, ...providerHosts]);
  const providers = Object.entries(PROVIDER_HOSTS).map(([provider, { sandbox }]): Interception => {
    const grant = credentials.providers.find((candidate) => candidate.provider === provider);
    return grant === undefined
      ? { _tag: "Denied", host: sandbox, scheme: "http" }
      : { _tag: "Provider", host: sandbox, provider: grant.provider, credential: grant.credential };
  });
  return [
    ...GITHUB_HOSTS.map((host): Interception =>
      Option.match(credentials.github, {
        onNone: () => ({ _tag: "Denied", host, scheme: "https" }),
        onSome: (token) => ({ _tag: "GitHub", host, token }),
      }),
    ),
    ...providers,
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

/**
 * Returns the URL for `host` over HTTPS with the path and query of `request`. The host comes from
 * the handler, never from the sandbox: a path such as `//attacker.example/x` stays a path.
 */
const upstreamUrl = (request: Request, host: string): URL => {
  const incoming = new URL(request.url);
  const upstream = new URL(`https://${host}`);
  upstream.pathname = incoming.pathname;
  upstream.search = incoming.search;
  return upstream;
};

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
  return new Request(upstreamUrl(request, host), new Request(request, { headers }));
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
  const upstream = upstreamUrl(request, PROVIDER_HOSTS[provider].upstream);
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
