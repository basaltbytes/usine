import { WorkerName } from "@usine/core/worker";
import {
  type AttachRequest,
  type Attached,
  type AttachmentId,
  type AttachmentList,
  type Detached,
  GatewayAdminApi,
  type LlmProviderList,
} from "@usine/gateway/admin";
import { Data, DateTime, Effect, Option, type Redacted, Result, Schema } from "effect";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import type { SshWorkerGateway } from "../model.ts";
import { type GatewayForward, GatewayForwardClosed, type OpenForward } from "./forward.ts";

const GatewayAdminOperation = Schema.Literals(["attach", "renew", "detach", "list", "providers"]);
type GatewayAdminOperation = typeof GatewayAdminOperation.Type;

const ACTIONS = {
  attach: "attach a token",
  renew: "renew an attachment",
  detach: "detach an attachment",
  list: "list the attachments",
  providers: "list the LLM providers",
} as const satisfies Record<GatewayAdminOperation, string>;

/**
 * The error for a failed Gateway admin API request. `message` contains no token; the request
 * and raw failure are discarded because an attach request contains the installation token.
 */
export class GatewayAdminError extends Schema.TaggedError<GatewayAdminError>(
  "@usine/executor/GatewayAdminError",
)("GatewayAdminError", {
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
   * Returns the LLM providers the Gateway has credentials for, with each credential kind. Returns
   * `None` if the Gateway predates this endpoint.
   */
  readonly providers: Effect.Effect<Option.Option<LlmProviderList>, GatewayAdminError>;
}

/** The timeout for one admin request. A publish keeps the Attempt's scope open while it runs. */
const ADMIN_REQUEST_TIMEOUT = "30 seconds";

/**
 * The error when an admin request through the open forward gets no response. `since` is when
 * the first unanswered request after the last response was sent.
 */
class GatewayAdminUnanswered extends Data.TaggedError("GatewayAdminUnanswered")<{
  readonly gateway: string;
  readonly since: DateTime.Utc;
  readonly detail: string;
}> {}

/** Returns the failure reason, built only from the forward's state or the failure's tag and status. */
const reason = (failure: { readonly _tag: string }): string => {
  if (failure instanceof GatewayForwardClosed)
    return `the forward through ${failure.gateway} has been closed since ${DateTime.formatIso(failure.since)}: ${failure.reason}`;
  if (failure instanceof GatewayAdminUnanswered)
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
  if (failure instanceof GatewayForwardClosed)
    return { closedSince: DateTime.formatIso(failure.since) };
  if (failure instanceof GatewayAdminUnanswered)
    return { unansweredSince: DateTime.formatIso(failure.since) };
  return {};
};

const adminClientAt = (url: URL, adminToken: Redacted.Redacted<string>) =>
  HttpApiClient.make(GatewayAdminApi, {
    baseUrl: url,
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(adminToken)),
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
        return yield* new GatewayAdminUnanswered({
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
    if (!(answered.failure instanceof GatewayAdminUnanswered))
      return yield* Effect.fail(answered.failure);
    return yield* retried(opened.success.generation, answered.failure);
  });
  const bounded =
    (operation: GatewayAdminOperation) =>
    <A, E extends { readonly _tag: string }>(
      call: (client: AdminClient) => Effect.Effect<A, E>,
    ): Effect.Effect<A, GatewayAdminError> =>
      exchange(operation, call).pipe(
        Effect.mapError(
          (failure) =>
            new GatewayAdminError({
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
        Effect.map(Option.some),
        Effect.catchIf(unknownRoute, () => Effect.succeedNone),
      ),
    ),
  } satisfies GatewayAdmin;
});
