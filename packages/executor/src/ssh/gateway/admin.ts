import type { ModelProviderCatalog } from "@usine/core/agent/provider";
import { GatewayCredentialKind, WorkerName } from "@usine/core/worker";
import {
  type AttachRequest,
  type Attached,
  type AttachmentId,
  type AttachmentList,
  type Detached,
  GatewayAdminApi,
  AdminAuthorization,
} from "@usine/gateway/admin";
import { type Brand, DateTime, Effect, Option, type Redacted, Result, Schema } from "effect";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import { HttpApi, HttpApiGroup, HttpApiEndpoint, HttpApiClient } from "effect/http-api";
import type { SshWorkerGateway } from "../model.ts";
import type { GatewayLlmPrefixes } from "./environment.ts";
import { type GatewayForward, GatewayForwardClosed, type OpenForward } from "./forward.ts";

const GatewayAdminOperation = Schema.Literals([
  "attach",
  "renew",
  "detach",
  "list",
  "providers",
  "connections",
]);
type GatewayAdminOperation = typeof GatewayAdminOperation.Type;

const ACTIONS = {
  attach: "attach a token",
  renew: "renew an attachment",
  detach: "detach an attachment",
  list: "list the attachments",
  providers: "list the LLM providers",
  connections: "read the provider credentials",
} as const satisfies Record<GatewayAdminOperation, string>;

/**
 * The error for a failed Gateway admin API request. `message` contains no token; the request
 * and raw failure are discarded because an attach request contains the installation token.
 */
export class GatewayAdminError extends Schema.TaggedError<
  GatewayAdminError,
  Brand.Brand<"@usine/executor/ssh/gateway/admin/GatewayAdminError">
>("@usine/executor/GatewayAdminError")("GatewayAdminError", {
  worker: WorkerName,
  operation: GatewayAdminOperation,
  message: Schema.NonEmptyString,
}) {}

export interface GatewayAdmin {
  /** Attaches an Attempt's token for the Worker and a repository. Returns the attachment ID and its caller token. */
  readonly attach: (request: AttachRequest) => Effect.Effect<Attached, GatewayAdminError>;
  /** Replaces the token and expiry of attachment `id`, or re-creates it after a Gateway restart. The caller token doesn't change. */
  readonly renew: (
    id: AttachmentId,
    request: AttachRequest,
  ) => Effect.Effect<Attached, GatewayAdminError>;
  /** Removes attachment `id` and returns whether it existed. */
  readonly detach: (id: AttachmentId) => Effect.Effect<Detached, GatewayAdminError>;
  /** Returns the active attachments for all the Gateway's Workers. */
  readonly list: Effect.Effect<AttachmentList, GatewayAdminError>;
  /**
   * Returns the LLM providers the Gateway has credentials for, with each credential kind, and the
   * slots it serves. Returns `None` if the Gateway predates this endpoint.
   */
  readonly providers: Effect.Effect<Option.Option<ProviderReport>, GatewayAdminError>;
  /**
   * Returns whether the Gateway serves the provider-credentials admin API, which Settings uses
   * to connect provider logins. Gateways before it answer 404.
   */
  readonly servesProviderCredentials: Effect.Effect<boolean, GatewayAdminError>;
}

/**
 * A Gateway's provider report as any release decodes it: each provider by the name the Gateway
 * gives it, from the provider catalog on, the routes of every slot it serves, and later the
 * credential kind of each slot that holds one.
 */
const ProviderReport = Schema.Struct({
  providers: Schema.Array(
    Schema.Struct({ provider: Schema.String, credential: GatewayCredentialKind }),
  ),
  slots: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        slot: Schema.String,
        routes: Schema.Array(Schema.String),
        credential: Schema.optionalKey(GatewayCredentialKind),
      }),
    ),
  ),
});
export type ProviderReport = typeof ProviderReport.Type;

/** The LLM providers a Gateway reports, by slot, the path prefixes it serves, and its slots' routes. */
export interface ReportedProviders {
  /**
   * The credential kind of each slot that the Gateway holds a credential for, from `providers`
   * and, when the Gateway reports them, from its slots.
   */
  readonly credentials: Readonly<Record<string, GatewayCredentialKind>>;
  readonly prefixes: GatewayLlmPrefixes;
  /** The routes of each slot that the Gateway serves, or `None` if it predates the provider catalog. */
  readonly slots: Option.Option<Readonly<Record<string, ReadonlyArray<string>>>>;
}

/**
 * Reads `report` with the slots of `providers`: a Gateway from before slots names each provider by
 * its ID, and serves path prefixes by the same names. A Gateway that reports each slot's credential
 * lists in `providers` only the slots that orchestrators from before the provider catalog decode.
 */
export const reportedProviders = (
  providers: ModelProviderCatalog,
  report: ProviderReport,
): ReportedProviders => {
  const named = report.providers.map(({ provider, credential }) => ({
    reported: provider,
    slot: Option.match(providers.find(provider), {
      onNone: () => provider,
      onSome: ({ slot }) => slot,
    }),
    credential,
  }));
  const slotCredentials = (report.slots ?? []).flatMap(({ slot, credential }) =>
    credential === undefined ? [] : [[slot, credential] as const],
  );
  return {
    credentials: Object.fromEntries([
      ...named.map(({ slot, credential }) => [slot, credential] as const),
      ...slotCredentials,
    ]),
    prefixes: named.some(({ reported, slot }) => reported !== slot) ? "provider" : "slot",
    slots: Option.map(Option.fromUndefinedOr(report.slots), (slots) =>
      Object.fromEntries(slots.map(({ slot, routes }) => [slot, routes])),
    ),
  };
};

/** The timeout for one admin request. A publish keeps the Attempt's scope open while it runs. */
const ADMIN_REQUEST_TIMEOUT = "30 seconds";

/**
 * The error when an admin request through the open forward gets no response. `since` is when
 * the first unanswered request after the last response was sent.
 */
class GatewayAdminUnanswered extends Schema.TaggedError<
  GatewayAdminUnanswered,
  { readonly Brand: unique symbol }
>()("GatewayAdminUnanswered", {
  gateway: Schema.String,
  since: Schema.DateTimeUtc,
  detail: Schema.String,
}) {}

/** Returns the failure reason, built only from the forward's state or the failure's tag and status. */
const reason = (failure: { readonly _tag: string }): string => {
  if (Schema.is(GatewayForwardClosed)(failure))
    return `the forward through ${failure.gateway} has been closed since ${DateTime.formatIso(failure.since)}: ${failure.reason}`;
  if (Schema.is(GatewayAdminUnanswered)(failure))
    return `the admin API through ${failure.gateway} hasn't responded since ${DateTime.formatIso(failure.since)}: ${failure.detail}`;
  if (HttpClientError.isHttpClientError(failure))
    return failure.response === undefined
      ? `no response (${failure.reason._tag})`
      : `the admin API returned status ${String(failure.response.status)}`;
  switch (failure._tag) {
    case "TimeoutError":
      return `no response within ${ADMIN_REQUEST_TIMEOUT}`;
    case "Unauthorized":
      return "the gateway rejected the admin token";
    case "AttachmentAlreadyExpired":
      return "the token had already expired";
    case "AttachmentConflict":
      return "the attachment ID belongs to another worker or repository";
    case "SchemaError":
      return "the admin API response doesn't match its schema";
    case "ProviderCredentialError":
      return "the admin API returned status 503: the gateway has no usable provider credential store";
    default:
      return `the request failed with ${failure._tag}`;
  }
};

/** Returns whether the admin API returned 404 because the Gateway predates the endpoint. */
const unknownRoute = (failure: { readonly _tag: string }): boolean =>
  HttpClientError.isHttpClientError(failure) && failure.response?.status === 404;

/** Returns whether the request got no response, possibly because the forward's SSH connection died unnoticed. */
const unanswered = (failure: { readonly _tag: string }): boolean =>
  failure._tag === "TimeoutError" ||
  (HttpClientError.isHttpClientError(failure) && failure.response === undefined);

/** Returns the log field with the time the admin API became unreachable, if the failure has it. */
const sinceFields = (failure: { readonly _tag: string }) => {
  if (Schema.is(GatewayForwardClosed)(failure))
    return { closedSince: DateTime.formatIso(failure.since) };
  if (Schema.is(GatewayAdminUnanswered)(failure))
    return { unansweredSince: DateTime.formatIso(failure.since) };
  return {};
};

// Gateways name providers by provider ID before slots, and by slot after, and a later Gateway can
// report a slot that this orchestrator doesn't know.
const CompatibleProvidersApi = HttpApi.make("CompatibleProvidersApi").add(
  HttpApiGroup.make("llm")
    .add(HttpApiEndpoint.get("providers", "/v1/providers", { success: ProviderReport }))
    .middleware(AdminAuthorization),
);

const adminClientAt = (url: URL, adminToken: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const options = {
      baseUrl: url,
      transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(adminToken)),
    };
    const client = yield* HttpApiClient.make(GatewayAdminApi, options);
    const compatible = yield* HttpApiClient.make(CompatibleProvidersApi, options);
    return {
      ...client,
      llm: { providers: compatible.llm.providers, connections: client.llm.connections },
    };
  });

type AdminClient = Effect.Success<ReturnType<typeof adminClientAt>>;

/**
 * Returns the admin API client for the Gateway in front of `worker`, connected through
 * `forward` with the admin token as a bearer token. If the forward is closed or a request gets
 * no response, reopens the forward and retries once.
 */
export const gatewayAdminFor = Effect.fn("SshExecutor.gatewayAdminFor")(function* (
  worker: WorkerName,
  gateway: SshWorkerGateway,
  forward: GatewayForward,
) {
  const http = yield* HttpClient.HttpClient;
  const exchange = Effect.fn("SshExecutor.gatewayAdminRequest")(function* <
    A,
    E extends { readonly _tag: string },
  >(operation: GatewayAdminOperation, call: (client: AdminClient) => Effect.Effect<A, E>) {
    yield* Effect.annotateCurrentSpan({ worker, operation, gateway: forward.gateway });
    const through = Effect.fnUntraced(function* (open: OpenForward) {
      const sentAt = yield* DateTime.now;
      const sent = yield* Effect.result(
        adminClientAt(open.url, gateway.adminToken).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.flatMap(call),
          Effect.timeout(ADMIN_REQUEST_TIMEOUT),
        ),
      );
      if (Result.isFailure(sent) && unanswered(sent.failure))
        return yield* GatewayAdminUnanswered.make({
          gateway: forward.gateway,
          since: yield* forward.unanswered(sentAt),
          detail: reason(sent.failure),
        });
      yield* forward.answered;
      if (Result.isFailure(sent)) return yield* Effect.fail(sent.failure);
      return sent.success;
    });
    const retried = (generation: number, failure: { readonly _tag: string }) =>
      Effect.logWarning(
        "A Gateway admin request did not get through; reopening the forward and sending it once more",
        {
          worker,
          operation,
          gateway: forward.gateway,
          generation,
          reason: reason(failure),
          ...sinceFields(failure),
        },
      ).pipe(Effect.andThen(forward.reopen(generation)), Effect.flatMap(through));

    const opened = yield* Effect.result(forward.current);
    if (Result.isFailure(opened)) return yield* retried(opened.failure.generation, opened.failure);
    const answered = yield* Effect.result(through(opened.success));
    if (Result.isSuccess(answered)) return answered.success;
    if (!Schema.is(GatewayAdminUnanswered)(answered.failure))
      return yield* Effect.fail(answered.failure);
    return yield* retried(opened.success.generation, answered.failure);
  });
  const bounded =
    (operation: GatewayAdminOperation) =>
    <A, E extends { readonly _tag: string }>(
      call: (client: AdminClient) => Effect.Effect<A, E>,
    ): Effect.Effect<A, GatewayAdminError> =>
      exchange(operation, call).pipe(
        Effect.mapError((failure) =>
          GatewayAdminError.make({
            worker,
            operation,
            message: `Can't ${ACTIONS[operation]} on the admin API of gateway ${forward.gateway} for worker "${worker}": ${reason(failure)}`,
          }),
        ),
      );
  return {
    attach: (request) =>
      bounded("attach")((client) => client.attachments.attach({ payload: request })),
    renew: (id, request) =>
      bounded("renew")((client) => client.attachments.renew({ params: { id }, payload: request })),
    detach: (id) => bounded("detach")((client) => client.attachments.detach({ params: { id } })),
    list: bounded("list")((client) => client.attachments.list()),
    providers: bounded("providers")((client) =>
      client.llm.providers().pipe(
        Effect.asSome,
        Effect.catchIf(unknownRoute, () => Effect.succeedNone),
      ),
    ),
    // Only the route matters: a failure with a response other than 404 means the Gateway serves it.
    servesProviderCredentials: bounded("connections")((client) =>
      client.llm.connections().pipe(
        Effect.as(true),
        Effect.catchIf(unknownRoute, () => Effect.succeed(false)),
        Effect.catchIf(
          (failure) => !unanswered(failure),
          (failure) =>
            Effect.logWarning(
              "The Gateway's provider-credentials admin API answered with an error; the Gateway serves it, so it counts as current",
              { worker, gateway: forward.gateway, reason: reason(failure) },
            ).pipe(Effect.as(true)),
        ),
      ),
    ),
  } satisfies GatewayAdmin;
});
