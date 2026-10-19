import { canonicalRepositoryName } from "@usine/core/repository";
import { Context, Data, Effect, Layer, Match, Option, Result, Schema } from "effect";
import {
  Headers,
  HttpClient,
  type HttpClientError,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import type { Attachment } from "../attachment/attachment.ts";
import { Attachments } from "../attachment/store.ts";
import {
  type CallerClaims,
  CallerTokens,
  presentedToken,
  withoutCallerCredentials,
} from "../caller/caller.ts";
import {
  GITHUB_HOSTS,
  type GitHubHost,
  githubRoute,
  withGitHubCredential,
} from "../github/github.ts";
import { configuredProvider, llmTarget, withProviderCredential } from "../llm/llm.ts";
import { GatewaySettings, gatewayHosts, SettingsInForce } from "../settings.ts";
import { endToEndHeaders, forwardRequest } from "./forward.ts";

/**
 * Why the gateway refused a request. Every refusal is logged at warning
 * level with this reason, the host, and the Worker when the caller token
 * names one, and the response carries it in `x-usine-gateway-refusal`.
 */
export const RefusalReason = Schema.Literals([
  "unknown-host",
  "unsupported-path",
  "missing-caller-token",
  "invalid-caller-token",
  "stale-caller-token",
  "attachment-expired",
  "repository-mismatch",
  "provider-not-configured",
]);
export type RefusalReason = typeof RefusalReason.Type;

/** The header a refused response names its reason in. */
export const REFUSAL_HEADER = "x-usine-gateway-refusal";

const REFUSAL_STATUS = {
  "unknown-host": 404,
  "unsupported-path": 404,
  "missing-caller-token": 401,
  "invalid-caller-token": 401,
  "stale-caller-token": 403,
  "attachment-expired": 403,
  "repository-mismatch": 403,
  "provider-not-configured": 503,
} as const satisfies Record<RefusalReason, number>;

/** A refusal, with the caller's claims once its token has been verified. */
class Refused extends Data.TaggedError("Refused")<{
  readonly reason: RefusalReason;
  readonly message: string;
  readonly caller: Option.Option<CallerClaims>;
}> {}

/** A refusal before the caller token was verified. */
const refused = (reason: RefusalReason, message: string) =>
  new Refused({ reason, message, caller: Option.none() });

/** A refusal of a verified caller. */
const refusedCaller = (claims: CallerClaims, reason: RefusalReason, message: string) =>
  new Refused({ reason, message, caller: Option.some(claims) });

/** Where a request is going: the host it named, without a port, and its path and query. */
interface RequestTarget {
  readonly host: string;
  readonly pathname: string;
  readonly search: string;
}

/** Reads the target from an origin-form request and its `Host`, or from an absolute-form request URL. */
const requestTarget = (
  request: HttpServerRequest.HttpServerRequest,
): Option.Option<RequestTarget> => {
  const parse = (base?: string) => Result.getSuccess(Result.try(() => new URL(request.url, base)));
  return parse().pipe(
    Option.orElse(() =>
      Option.flatMap(Headers.get(request.headers, "host"), (host) => parse(`http://${host}`)),
    ),
    Option.map((url) => ({
      host: url.hostname.toLowerCase(),
      pathname: url.pathname,
      search: url.search,
    })),
  );
};

/**
 * The reverse proxy Worker VMs reach on the private network. `git.<domain>`
 * serves GitHub with the attached installation token and `llm.<domain>`
 * serves the LLM providers with the gateway's API keys in force; every
 * request presents a caller token whose attachment is in force. Any other
 * host is refused: the forward proxy serves the allowlisted ones.
 */
export class GatewayProxy extends Context.Service<
  GatewayProxy,
  {
    /** Forwards one Worker request with the attached credential, or refuses it and logs why. */
    readonly handle: Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      never,
      HttpServerRequest.HttpServerRequest
    >;
  }
>()("@usine/gateway/GatewayProxy") {
  static readonly layer = Layer.effect(
    GatewayProxy,
    Effect.gen(function* () {
      const settings = yield* GatewaySettings;
      const inForce = yield* SettingsInForce;
      const attachments = yield* Attachments;
      const callers = yield* CallerTokens;
      const client = yield* HttpClient.HttpClient;
      const hosts = gatewayHosts(settings.domain);

      const authenticate = Effect.fn("GatewayProxy.authenticate")(function* (
        request: HttpServerRequest.HttpServerRequest,
      ) {
        const presented = presentedToken(request.headers);
        if (Option.isNone(presented))
          return yield* refused("missing-caller-token", "The request has no gateway caller token.");
        const claims = yield* callers
          .verify(presented.value)
          .pipe(
            Effect.mapError(({ reason }) =>
              refused(
                "invalid-caller-token",
                `The gateway did not issue this caller token (${reason}).`,
              ),
            ),
          );
        yield* Effect.annotateCurrentSpan({
          attachment: claims.attachment,
          worker: claims.worker,
          repository: claims.repository,
        });
        const stale = refusedCaller(
          claims,
          "stale-caller-token",
          `The caller token belongs to attachment ${claims.attachment} of ${claims.repository} on Worker ${claims.worker}, which is no longer attached.`,
        );
        const lookup = yield* attachments.find(claims.attachment);
        return yield* Match.valueTags(lookup, {
          LiveAttachment: ({ attachment }) =>
            attachment.worker === claims.worker &&
            canonicalRepositoryName(attachment.repository) ===
              canonicalRepositoryName(claims.repository)
              ? Effect.succeed({ claims, attachment })
              : Effect.fail(stale),
          ExpiredAttachment: () =>
            Effect.fail(
              refusedCaller(
                claims,
                "attachment-expired",
                `The attachment of ${claims.repository} to Worker ${claims.worker} has expired.`,
              ),
            ),
          MissingAttachment: () => Effect.fail(stale),
        });
      });

      const github = Effect.fn("GatewayProxy.github")(function* (
        request: HttpServerRequest.HttpServerRequest,
        target: RequestTarget,
        host: GitHubHost,
      ) {
        const { claims, attachment } = yield* authenticate(request);
        const route = githubRoute(settings.github, host, target.pathname, target.search);
        if (Option.isNone(route))
          return yield* refusedCaller(
            claims,
            "unsupported-path",
            `The gateway serves git smart HTTP and the GitHub API, not ${target.pathname}.`,
          );
        const named = route.value.repository;
        if (
          Option.isSome(named) &&
          canonicalRepositoryName(named.value) !== canonicalRepositoryName(claims.repository)
        )
          return yield* refusedCaller(
            claims,
            "repository-mismatch",
            `The caller token was issued for ${claims.repository}, not ${named.value}.`,
          );
        const headers = withGitHubCredential(
          route.value,
          attachment.credential,
          withoutCallerCredentials(endToEndHeaders(request.headers)),
        );
        const response = yield* forwardRequest(client, request, route.value.upstream, headers);
        yield* forwarded("Forwarded a GitHub request", request, target, attachment, response, {
          protocol: route.value.protocol,
        });
        return response;
      });

      const llm = Effect.fn("GatewayProxy.llm")(function* (
        request: HttpServerRequest.HttpServerRequest,
        target: RequestTarget,
      ) {
        const { claims, attachment } = yield* authenticate(request);
        const destination = llmTarget(target.pathname);
        if (Option.isNone(destination))
          return yield* refusedCaller(
            claims,
            "unsupported-path",
            `The gateway serves /anthropic and /openai on ${hosts.llm}, not ${target.pathname}.`,
          );
        const { providers } = yield* inForce.current;
        const provider = configuredProvider(providers, destination.value.provider);
        if (Option.isNone(provider))
          return yield* refusedCaller(
            claims,
            "provider-not-configured",
            `The gateway has no credential for ${destination.value.provider}.`,
          );
        const headers = withProviderCredential(
          provider.value,
          withoutCallerCredentials(endToEndHeaders(request.headers)),
        );
        const upstream = `${provider.value.upstream}${destination.value.rest}${target.search}`;
        const response = yield* forwardRequest(client, request, upstream, headers);
        yield* forwarded("Forwarded an LLM request", request, target, attachment, response, {
          provider: destination.value.provider,
        });
        return response;
      });

      const route = (request: HttpServerRequest.HttpServerRequest, target: RequestTarget) => {
        if (target.host === hosts.git) return github(request, target, "gateway");
        const githubHost = GITHUB_HOSTS.get(target.host);
        if (githubHost !== undefined) return github(request, target, githubHost);
        if (target.host === hosts.llm) return llm(request, target);
        return Effect.fail(
          refused(
            "unknown-host",
            `The gateway serves ${hosts.git} and ${hosts.llm}, not ${target.host}; other hosts go through the forward proxy.`,
          ),
        );
      };

      const handle = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const target = requestTarget(request);
        if (Option.isNone(target)) {
          const error = refused("unknown-host", "The request names no host.");
          yield* Effect.logWarning("Gateway refused a request", {
            reason: error.reason,
            method: request.method,
            client: clientAddress(request),
          });
          return refusalResponse(error);
        }
        yield* Effect.annotateCurrentSpan({ host: target.value.host, method: request.method });
        return yield* route(request, target.value).pipe(
          Effect.catchTags({
            Refused: (error) =>
              logRefusal(request, target.value, error).pipe(Effect.as(refusalResponse(error))),
            HttpClientError: (error) => upstreamFailure(request, target.value, error),
          }),
        );
      }).pipe(Effect.withSpan("GatewayProxy.handle"));

      return { handle };
    }),
  );
}

const refusalResponse = (error: Refused): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(
    { message: `usine gateway: ${error.message}`, reason: error.reason },
    { status: REFUSAL_STATUS[error.reason], headers: { [REFUSAL_HEADER]: error.reason } },
  );

const clientAddress = (request: HttpServerRequest.HttpServerRequest): string =>
  Option.getOrElse(request.remoteAddress, () => "unknown");

const logRefusal = (
  request: HttpServerRequest.HttpServerRequest,
  target: RequestTarget,
  error: Refused,
) => {
  const caller = Option.match(error.caller, {
    onNone: () => ({ caller: "unverified" }),
    onSome: ({ worker, repository }) => ({ worker, repository }),
  });
  return Effect.logWarning("Gateway refused a request", {
    reason: error.reason,
    host: target.host,
    method: request.method,
    path: target.pathname,
    client: clientAddress(request),
    ...caller,
  });
};

const forwarded = (
  message: string,
  request: HttpServerRequest.HttpServerRequest,
  target: RequestTarget,
  attachment: Attachment,
  response: HttpServerResponse.HttpServerResponse,
  detail: Readonly<Record<string, string>>,
) =>
  Effect.logInfo(message, {
    ...detail,
    worker: attachment.worker,
    repository: attachment.repository,
    host: target.host,
    method: request.method,
    path: target.pathname,
    status: response.status,
  });

const upstreamFailure = (
  request: HttpServerRequest.HttpServerRequest,
  target: RequestTarget,
  error: HttpClientError.HttpClientError,
) =>
  Effect.logError("The upstream of a Worker request could not be reached", {
    host: target.host,
    method: request.method,
    path: target.pathname,
    client: clientAddress(request),
    error: error.reason._tag,
  }).pipe(
    Effect.as(
      HttpServerResponse.jsonUnsafe(
        {
          message: "usine gateway: the upstream could not be reached.",
          reason: "upstream-unreachable",
        },
        { status: 502 },
      ),
    ),
  );
