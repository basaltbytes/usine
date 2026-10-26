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

/** A request that Claude Code or Codex sends to its provider: a method, and a pattern of its path. */
interface HarnessRoute {
  readonly method: "GET" | "POST";
  readonly path: RegExp;
}

/**
 * The routes each provider's handler forwards: the paths that the Gateway's `llm.<domain>` serves
 * (ADR 0027), each with the method that the harnesses use. Each pattern matches whole plain
 * segments, so a percent-encoded separator or a dot segment never matches, and the rest of the
 * provider's API, such as files or organization administration, can't be reached with the key.
 */
const HARNESS_ROUTES = {
  anthropic: [
    { method: "POST", path: /^\/v1\/messages$/u },
    { method: "POST", path: /^\/v1\/messages\/count_tokens$/u },
    { method: "GET", path: /^\/v1\/models$/u },
    { method: "GET", path: /^\/v1\/models\/[A-Za-z0-9][A-Za-z0-9._-]*$/u },
  ],
  openai: [
    { method: "POST", path: /^\/v1\/responses$/u },
    { method: "POST", path: /^\/v1\/responses\/compact$/u },
    { method: "GET", path: /^\/v1\/models$/u },
  ],
} as const satisfies Record<CloudflareLlmProvider, ReadonlyArray<HarnessRoute>>;

/**
 * Returns `request`, sent over plain HTTP to the provider's sandbox host, for the provider's
 * upstream over HTTPS with the provider credential in place of the sandbox's placeholder.
 * Returns `None` for a request that isn't one of the provider's `HARNESS_ROUTES`.
 */
export const providerRequest = (
  request: Request,
  provider: CloudflareLlmProvider,
  credential: ProviderCredential,
): Option.Option<Request> => {
  const upstream = upstreamUrl(request, PROVIDER_HOSTS[provider].upstream);
  const routes: ReadonlyArray<HarnessRoute> = HARNESS_ROUTES[provider];
  if (!routes.some(({ method, path }) => method === request.method && path.test(upstream.pathname)))
    return Option.none();
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
  return Option.some(new Request(upstream, new Request(request, { headers })));
};
