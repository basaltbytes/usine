import {
  type ModelProvider,
  type ModelProviderCatalog,
  ModelProviderId,
  upstreamSearch,
} from "@usine/core/agent/provider";
import { Array as Arr, Effect, Match, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import { ProviderCredential, type SandboxCredentials } from "../api/api.ts";
import { GITHUB_HOSTS, type GitHubHost, sandboxHost } from "../api/harness.ts";

export const forwardRequest = Effect.fn("Sandbox.forwardRequest")(function* (
  handler: string,
  request: Request,
  forwarded: Request = request,
) {
  const route = {
    handler,
    method: request.method,
    host: new URL(request.url).host,
    path: new URL(request.url).pathname,
  };
  yield* Effect.annotateCurrentSpan(route);
  // Cloudflare fetch supports WebSocket upgrades; Effect's HTTP client rejects them.
  const platformFetch = yield* FetchHttpClient.Fetch;
  const response = yield* Effect.tryPromise({
    try: () => platformFetch(forwarded),
    catch: (cause) =>
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({
          request: HttpClientRequest.fromWeb(forwarded),
          cause,
        }),
      }),
  }).pipe(Effect.tapError(() => Effect.logWarning("Failed to forward a sandbox request", route)));
  yield* Effect.logInfo("Forwarded a sandbox request", { ...route, status: response.status });
  return response;
});

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
  readonly provider: ModelProvider;
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
 * Returns whether a sandbox reaches `provider` with an API key: the provider takes one, and each of
 * its upstreams uses HTTPS, because the key leaves the Worker for them. The sandbox's own hop to
 * the provider's sandbox host is plain HTTP, with a placeholder.
 */
export const servedInSandbox = (provider: ModelProvider): boolean =>
  provider.accepts("api-key") &&
  provider.protocols.every(({ upstream }) => upstream.startsWith("https://"));

/**
 * Returns the hosts a sandbox reaches: GitHub and the providers of `catalog` with the Attempt's
 * credentials, and `allowedHosts` unchanged. The container has no other way out. GitHub and
 * provider hosts without a credential are denied rather than left out, because a running
 * container keeps its last handler for a host; they're never treated as allowlisted. For the same
 * reason, each host of `registered`, the provider hosts that the container has handlers for, is
 * denied over HTTP once no provider of `catalog` has it, even when `allowedHosts` lists it.
 */
export const interceptionsFor = (
  catalog: ModelProviderCatalog,
  credentials: SandboxCredentials,
  allowedHosts: ReadonlyArray<string>,
  registered: ReadonlyArray<string> = [],
): ReadonlyArray<Interception> => {
  const providerHosts = catalog.providers.map(({ id }) => sandboxHost(id));
  const reserved = new Set<string>([...GITHUB_HOSTS, ...providerHosts]);
  const providers = catalog.providers.map((provider): Interception => {
    const host = sandboxHost(provider.id);
    const grant = credentials.providers.find((candidate) => candidate.provider === provider.id);
    return grant === undefined || !servedInSandbox(provider)
      ? { _tag: "Denied", host, scheme: "http" }
      : { _tag: "Provider", host, provider, credential: grant.credential };
  });
  const allowed = Arr.dedupe(allowedHosts).filter((host) => !reserved.has(host));
  const revoked = Arr.dedupe(registered).filter((host) => !reserved.has(host));
  return [
    ...GITHUB_HOSTS.map((host): Interception =>
      Option.match(credentials.github, {
        onNone: () => ({ _tag: "Denied", host, scheme: "https" }),
        onSome: (token) => ({ _tag: "GitHub", host, token }),
      }),
    ),
    ...providers,
    ...revoked.map((host): Interception => ({ _tag: "Denied", host, scheme: "http" })),
    ...allowed.map((host): Interception => ({ _tag: "Allowed", host })),
  ];
};

/**
 * Returns the provider hosts that a container has handlers for after `interceptions` are
 * registered over the handlers for `registered`.
 */
export const registeredProviderHosts = (
  registered: ReadonlyArray<string>,
  interceptions: ReadonlyArray<Interception>,
): ReadonlyArray<string> =>
  Arr.dedupe([
    ...registered,
    ...interceptions.flatMap((interception) =>
      interception._tag === "Provider" ||
      (interception._tag === "Denied" && interception.scheme === "http")
        ? [interception.host]
        : [],
    ),
  ]);

/** Returns the hosts in a comma-separated `ALLOWED_HOSTS` value, lowercased, without blanks. */
export const allowedHostsOf = (value: string): ReadonlyArray<string> =>
  value
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== "");

/**
 * The headers a tool in the sandbox can use to send a credential. All are replaced, with the key
 * headers of a provider's protocols.
 */
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
 * Returns `request`, sent over plain HTTP to the provider's sandbox host, for the upstream of the
 * provider's protocol that serves its path, with the key in that protocol's header in place of the
 * sandbox's credentials. `cookie`, the key header of each provider of `catalog`, and the `key`
 * query parameter are left out. Returns `None` for a path outside the provider's routes, a method
 * that its route doesn't accept, or an upstream without HTTPS, so the rest of the provider's API,
 * such as files or organization administration, can't be reached with the key. The request doesn't
 * follow redirects, so the key never goes to another host.
 * A route's placeholder matches one plain segment, so a percent-encoded separator or a dot segment
 * never matches.
 */
export const providerRequest = (
  request: Request,
  provider: ModelProvider,
  credential: ProviderCredential,
  catalog: ModelProviderCatalog,
): Option.Option<Request> => {
  const incoming = new URL(request.url);
  const served = Option.filter(
    provider.protocolFor(incoming.pathname),
    (protocol) =>
      protocol.allows(request.method, incoming.pathname) &&
      protocol.upstream.startsWith("https://"),
  );
  return Option.map(served, (protocol) => {
    const dropped = new Set<string>([
      "host",
      "cookie",
      ...[provider, ...catalog.providers].flatMap(({ protocols }) =>
        protocols.map(({ key }) => key.header),
      ),
    ]);
    const headers = new Headers(
      [...withoutCredentials(request)].filter(
        ([name]) => !dropped.has(name) && provider.passes(name),
      ),
    );
    Match.valueTags(credential, {
      ApiKey: ({ key }) =>
        headers.set(protocol.key.header, protocol.key.value(Redacted.value(key))),
    });
    const upstream = new URL(
      `${protocol.upstream}${incoming.pathname}${upstreamSearch(incoming.search)}`,
    );
    return new Request(upstream, new Request(request, { headers, redirect: "manual" }));
  });
};

/** The props of a GitHub host's outbound handler. */
export const GitHubProps = Schema.Struct({
  host: Schema.Literals(GITHUB_HOSTS),
  token: Schema.NonEmptyString,
});

/**
 * The provider ID and credential of a provider's outbound handler, as its props carry them. The
 * handler reads the provider's entry from the Worker's catalog on each request, so a handler that
 * outlives a deploy serves the current entry.
 */
export const ProviderProps = Schema.Struct({
  provider: ModelProviderId,
  credential: ProviderCredential,
});

/** The Worker entrypoint that serves an interception's host, with its props and the scheme it intercepts. */
export type Registration =
  | {
      readonly handler: "GitHubOutbound";
      readonly host: string;
      readonly scheme: "https";
      readonly props: typeof GitHubProps.Encoded;
    }
  | {
      readonly handler: "ProviderOutbound";
      readonly host: string;
      readonly scheme: "http";
      readonly props: typeof ProviderProps.Encoded;
    }
  | { readonly handler: "AllowedOutbound"; readonly host: string; readonly scheme: "https" }
  | {
      readonly handler: "DeniedOutbound";
      readonly host: string;
      readonly scheme: "http" | "https";
    };

/** Returns the Worker entrypoint that the container's requests for `interception`'s host go to. */
export const registrationOf = (interception: Interception) =>
  Match.valueTags(interception, {
    GitHub: ({ host, token }) =>
      Effect.succeed<Registration>({
        handler: "GitHubOutbound",
        host,
        scheme: "https",
        props: { host, token: Redacted.value(token) },
      }),
    Provider: ({ host, provider, credential }) =>
      Effect.map(
        Schema.encodeEffect(ProviderProps)({ provider: provider.id, credential }),
        (props): Registration => ({ handler: "ProviderOutbound", host, scheme: "http", props }),
      ),
    Allowed: ({ host }) =>
      Effect.succeed<Registration>({ handler: "AllowedOutbound", host, scheme: "https" }),
    Denied: ({ host, scheme }) =>
      Effect.succeed<Registration>({ handler: "DeniedOutbound", host, scheme }),
  });

/** The Worker's outbound entrypoints by name, each returning the handler for a host with its props. */
export interface OutboundEntrypoints<Handler> {
  readonly GitHubOutbound: (options: { readonly props: typeof GitHubProps.Encoded }) => Handler;
  readonly ProviderOutbound: (options: { readonly props: typeof ProviderProps.Encoded }) => Handler;
  readonly AllowedOutbound: (options: { readonly props: Record<string, never> }) => Handler;
  readonly DeniedOutbound: (options: { readonly props: Record<string, never> }) => Handler;
}

/** The container's methods that send its requests for a host to a handler. */
export interface OutboundInterceptor<Handler> {
  readonly interceptOutboundHttp: (host: string, handler: Handler) => Promise<void>;
  readonly interceptOutboundHttps: (host: string, handler: Handler) => Promise<void>;
}

/**
 * Sends the container's requests for the host of `registration` to the entrypoint of `entrypoints`
 * that it names, with its props, over its scheme.
 */
export const register = <Handler>(
  container: OutboundInterceptor<Handler>,
  entrypoints: OutboundEntrypoints<Handler>,
  registration: Registration,
): Promise<void> => {
  const handler = handlerOf(entrypoints, registration);
  return registration.scheme === "https"
    ? container.interceptOutboundHttps(registration.host, handler)
    : container.interceptOutboundHttp(registration.host, handler);
};

const handlerOf = <Handler>(
  entrypoints: OutboundEntrypoints<Handler>,
  registration: Registration,
): Handler => {
  switch (registration.handler) {
    case "GitHubOutbound":
      return entrypoints.GitHubOutbound({ props: registration.props });
    case "ProviderOutbound":
      return entrypoints.ProviderOutbound({ props: registration.props });
    case "AllowedOutbound":
      return entrypoints.AllowedOutbound({ props: {} });
    case "DeniedOutbound":
      return entrypoints.DeniedOutbound({ props: {} });
  }
};

const refusal = (status: number, message: string) =>
  new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/**
 * Answers a sandbox's request for a provider's host, with `props` as the Worker registered them:
 * forwards it to the upstream of the protocol that serves the path, with the provider's API key, or
 * refuses it with status 404. The provider's entry comes from `catalog`, the Worker's current one;
 * a provider that it no longer serves in a sandbox, or props that this Worker can't read, such as
 * those of an earlier deploy, are refused with status 403.
 */
export const providerOutbound = Effect.fn("Sandbox.providerOutbound")(function* (
  props: unknown,
  request: Request,
  catalog: ModelProviderCatalog,
) {
  const route = {
    method: request.method,
    host: new URL(request.url).host,
    path: new URL(request.url).pathname,
  };
  const decoded = yield* Schema.decodeUnknownEffect(ProviderProps)(props).pipe(Effect.option);
  if (Option.isNone(decoded)) {
    yield* Effect.logWarning("Refused a sandbox request whose handler props are unreadable", route);
    return refusal(403, "usine attached no credential that this Worker reads for this host.\n");
  }
  const { provider: id, credential } = decoded.value;
  const provider = Option.filter(catalog.get(id), servedInSandbox);
  if (Option.isNone(provider)) {
    yield* Effect.logWarning(
      "Refused a sandbox request for a provider that the Worker's catalog no longer serves",
      { ...route, handler: id },
    );
    return refusal(403, `usine no longer serves the provider ${id} in a sandbox.\n`);
  }
  const forwarded = providerRequest(request, provider.value, credential, catalog);
  if (Option.isSome(forwarded)) return yield* forwardRequest(id, request, forwarded.value);
  yield* Effect.logWarning("Refused a sandbox request for a route outside the provider's", {
    ...route,
    handler: id,
  });
  return refusal(404, `usine forwards only the ${provider.value.label} routes in its catalog.\n`);
});
