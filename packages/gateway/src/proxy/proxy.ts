import { canonicalRepositoryName } from "@usine/core/repository";
import { Context, Data, Effect, Layer, Match, Option, Result, Schema } from "effect";
import {
  Headers,
  HttpClient,
  type HttpClientError,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import type { Attachment, LiveAttachment } from "../attachment/attachment.ts";
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
  type GitHubRoute,
  gatewayLocation,
  githubRoute,
  withGitHubCredential,
} from "../github/github.ts";
import { ChatGptLogins } from "../chatgpt/logins.ts";
import {
  type ChatGptLogin,
  llmRoute,
  configuredProvider,
  llmTarget,
  withChatGptAccess,
  withStaticCredential,
} from "../llm/llm.ts";
import { GatewaySettings, gatewayHosts, SettingsInForce } from "../settings.ts";
import { endToEndHeaders, forwardRequest } from "./forward.ts";

/**
 * The reason the Gateway refused a request. Each refusal is logged at warning level with the
 * reason, host, and Worker (if known), and returned in `x-usine-gateway-refusal`.
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
  "provider-login-unavailable",
]);
export type RefusalReason = typeof RefusalReason.Type;

/** The response header that contains the refusal reason. */
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
  "provider-login-unavailable": 401,
} as const satisfies Record<RefusalReason, number>;

/** A refusal, with the caller's claims once its token is verified. */
class Refused extends Data.TaggedError("Refused")<{
  readonly reason: RefusalReason;
  readonly message: string;
  readonly caller: Option.Option<CallerClaims>;
}> {}

/** Returns a refusal for a request whose caller token isn't verified yet. */
const refused = (reason: RefusalReason, message: string) =>
  new Refused({ reason, message, caller: Option.none() });

/** Returns a refusal for a verified caller. */
const refusedCaller = (claims: CallerClaims, reason: RefusalReason, message: string) =>
  new Refused({ reason, message, caller: Option.some(claims) });

/** A request's host without its port, and its path and query. */
interface RequestTarget {
  readonly host: string;
  readonly pathname: string;
  readonly search: string;
}

/** Returns the target from an origin-form request and its `Host`, or from an absolute-form URL. */
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
 * The reverse proxy for Worker VMs on the private network. `git.<domain>` serves GitHub with
 * the attached installation token, and `llm.<domain>` serves the LLM providers with the
 * current credentials. Every request must have a caller token for an active attachment; other
 * hosts are refused.
 */
export class GatewayProxy extends Context.Service<
  GatewayProxy,
  {
    /** Forwards one Worker request with the attached credential, or refuses and logs it. */
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
      const logins = yield* ChatGptLogins;
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
                `The gateway didn't issue this caller token (${reason}).`,
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
          `The caller token belongs to attachment ${claims.attachment} of ${claims.repository} on worker "${claims.worker}", which is no longer attached.`,
        );
        const lookup = yield* attachments.find(claims.attachment);
        return yield* Match.valueTags(lookup, {
          LiveAttachment: (live) =>
            live.attachment.worker === claims.worker &&
            canonicalRepositoryName(live.attachment.repository) ===
              canonicalRepositoryName(claims.repository)
              ? Effect.succeed({ claims, live })
              : Effect.fail(stale),
          ExpiredAttachment: () =>
            Effect.fail(
              refusedCaller(
                claims,
                "attachment-expired",
                `The attachment of ${claims.repository} to worker "${claims.worker}" has expired.`,
              ),
            ),
          MissingAttachment: () => Effect.fail(stale),
        });
      });

      /**
       * Points a `Location` at github.com or api.github.com to `git.<domain>`, and logs the rewrite.
       * GitHub answers a renamed or transferred repository's former name with a permanent
       * redirect to its new name, so if `requested` named the repository, a 301 or 308 teaches
       * the attachment the repository its `Location` names. A path that names no repository, such
       * as `/repositories/ID/...`, teaches nothing: the gateway can't tell which repository it was.
       */
      const throughGateway = Effect.fn("GatewayProxy.throughGateway")(function* (
        answer: HttpServerResponse.HttpServerResponse,
        live: LiveAttachment,
        requested: GitHubRoute,
      ) {
        const { attachment } = live;
        const from = Option.flatMap(Headers.get(answer.headers, "location"), absoluteUrl);
        const to = Option.flatMap(from, (url) => gatewayLocation(settings.github, hosts.git, url));
        if (Option.isNone(from) || Option.isNone(to)) return answer;
        yield* Effect.logInfo("Rewrote a GitHub Location header to the gateway", {
          worker: attachment.worker,
          repository: attachment.repository,
          status: answer.status,
          from: from.value.host,
          path: to.value.pathname,
        });
        if (Option.isSome(requested.repository) && PERMANENT_REDIRECTS.has(answer.status)) {
          const named = githubRoute(settings.github, "gateway", to.value.pathname, to.value.search);
          const newName = Option.flatMap(named, ({ repository }) => repository);
          if (Option.isSome(newName)) yield* attachments.learnNewName(attachment.id, newName.value);
        }
        return HttpServerResponse.setHeader(answer, "location", to.value.href);
      });

      const github = Effect.fn("GatewayProxy.github")(function* (
        request: HttpServerRequest.HttpServerRequest,
        target: RequestTarget,
        host: GitHubHost,
      ) {
        const { claims, live } = yield* authenticate(request);
        const { attachment } = live;
        const route = githubRoute(settings.github, host, target.pathname, target.search);
        if (Option.isNone(route))
          return yield* refusedCaller(
            claims,
            "unsupported-path",
            `The gateway serves Git smart HTTP, release downloads, and the GitHub API, not ${target.pathname}.`,
          );
        const named = route.value.repository;
        if (Option.isSome(named) && !live.serves(named.value))
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
        const response = yield* throughGateway(
          yield* forwardRequest(client, request, route.value.upstream, headers),
          live,
          route.value,
        );
        yield* forwarded(
          route.value.protocol === "release"
            ? "Served a GitHub release download"
            : "Forwarded a GitHub request",
          request,
          target,
          attachment,
          response,
          { protocol: route.value.protocol, ...redirectTarget(response) },
        );
        return response;
      });

      const llm = Effect.fn("GatewayProxy.llm")(function* (
        request: HttpServerRequest.HttpServerRequest,
        target: RequestTarget,
      ) {
        const {
          claims,
          live: { attachment },
        } = yield* authenticate(request);
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
        const path = llmRoute(provider.value, destination.value.rest);
        if (Option.isNone(path))
          return yield* refusedCaller(
            claims,
            "unsupported-path",
            `The gateway serves only the routes Claude Code and Codex call on ${hosts.llm}, such as /anthropic/v1/messages and /openai/v1/responses, not ${target.pathname}.`,
          );
        const incoming = withoutCallerCredentials(endToEndHeaders(request.headers));
        const { credential } = provider.value;
        const outgoing =
          credential._tag === "ChatGptLogin"
            ? yield* chatGptRequest(claims, credential, incoming)
            : {
                headers: withStaticCredential(credential, incoming),
                answered: () => Effect.void,
              };
        const upstream = `${provider.value.upstream}${path.value}${target.search}`;
        const response = yield* forwardRequest(client, request, upstream, outgoing.headers);
        yield* outgoing.answered(response.status);
        yield* forwarded("Forwarded an LLM request", request, target, attachment, response, {
          provider: destination.value.provider,
          credential: credential._tag,
        });
        return response;
      });

      /**
       * Returns the headers for a request with a ChatGPT login, and records a 401 answer so the
       * next request refreshes the access token first.
       */
      const chatGptRequest = Effect.fn("GatewayProxy.chatGptRequest")(function* (
        claims: CallerClaims,
        login: ChatGptLogin,
        incoming: Headers.Headers,
      ) {
        const access = yield* logins
          .access(login)
          .pipe(
            Effect.mapError((error) =>
              refusedCaller(claims, "provider-login-unavailable", error.message),
            ),
          );
        return {
          headers: withChatGptAccess(access, incoming),
          answered: (status: number) =>
            status === 401 ? logins.refused(login, access) : Effect.void,
        };
      });

      /**
       * Refuses a host the reverse proxy doesn't serve. gh sends every request to the gateway,
       * including a followed redirect to a GitHub download host, so for an allowlisted host the
       * refusal says how to download from it with curl.
       */
      const unknownHost = Effect.fn("GatewayProxy.unknownHost")(function* (target: RequestTarget) {
        const { egress } = yield* inForce.current;
        const served = `The gateway serves ${hosts.git} and ${hosts.llm}, not ${target.host}`;
        return yield* refused(
          "unknown-host",
          egress.decide(target.host, 443)._tag === "EgressPermitted"
            ? `${served}, which the forward proxy serves. gh sends every request to the gateway, so it can't follow GitHub's redirect to ${target.host}. Download with curl -fL -u ":$GH_TOKEN" from ${hosts.git} instead, such as http://${hosts.git}/OWNER/REPO/releases/download/TAG/FILE, or http://${hosts.git}/api/v3/repos/OWNER/REPO/tarball/REF for an archive.`
            : `${served}. Send requests for other hosts through the forward proxy.`,
        );
      });

      const route = (request: HttpServerRequest.HttpServerRequest, target: RequestTarget) => {
        if (target.host === hosts.git) return github(request, target, "gateway");
        const githubHost = GITHUB_HOSTS.get(target.host);
        if (githubHost !== undefined) return github(request, target, githubHost);
        if (target.host === hosts.llm) return llm(request, target);
        return unknownHost(target);
      };

      const handle = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const target = requestTarget(request);
        if (Option.isNone(target)) {
          const error = refused("unknown-host", "The request has no host.");
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

/** The statuses GitHub uses to redirect a renamed or transferred repository's former name. */
const PERMANENT_REDIRECTS: ReadonlySet<number> = new Set([301, 308]);

const refusalResponse = (error: Refused): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(
    { message: `usine gateway: ${error.message}`, reason: error.reason },
    { status: REFUSAL_STATUS[error.reason], headers: { [REFUSAL_HEADER]: error.reason } },
  );

const absoluteUrl = (value: string): Option.Option<URL> =>
  Result.getSuccess(Result.try(() => new URL(value)));

/** Returns the host a response redirects to, without the `Location` path and query, which can hold a signature. */
const redirectTarget = (response: HttpServerResponse.HttpServerResponse) =>
  Option.match(Option.flatMap(Headers.get(response.headers, "location"), absoluteUrl), {
    onNone: () => ({}),
    onSome: (url) => ({ target: url.host }),
  });

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
          message: "usine gateway: the upstream is unreachable.",
          reason: "upstream-unreachable",
        },
        { status: 502 },
      ),
    ),
  );
