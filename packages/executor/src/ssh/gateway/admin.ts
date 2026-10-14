import { WorkerName } from "@usine/core/worker";
import {
  type AttachRequest,
  type Attached,
  type AttachmentId,
  type AttachmentList,
  type Detached,
  GatewayAdminApi,
} from "@usine/gateway/admin";
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import type { SshWorkerGateway } from "../model.ts";

/** An admin API operation the executor performs on a Worker's Gateway. */
const GatewayAdminOperation = Schema.Literals(["attach", "renew", "detach", "list"]);
type GatewayAdminOperation = typeof GatewayAdminOperation.Type;

/**
 * A request to a Worker's Gateway admin API failed. `message` says why in
 * terms that contain no token: the request and the raw failure are not kept,
 * because the request body of an attach carries the installation token.
 */
export class GatewayAdminError extends Schema.TaggedError<GatewayAdminError>(
  "@usine/executor/GatewayAdminError",
)("GatewayAdminError", {
  worker: WorkerName,
  operation: GatewayAdminOperation,
  message: Schema.NonEmptyString,
}) {}

/** The admin API of the Gateway in front of one Worker, as the executor calls it. */
export interface GatewayAdmin {
  /** Attaches an Attempt's token for the Worker and a repository; the answer has the new attachment id and its caller token. */
  readonly attach: (request: AttachRequest) => Effect.Effect<Attached, GatewayAdminError>;
  /** Replaces the token and expiry of attachment `id`, or stores it again after a Gateway restart; the caller token stays the same. */
  readonly renew: (
    id: AttachmentId,
    request: AttachRequest,
  ) => Effect.Effect<Attached, GatewayAdminError>;
  /** Removes attachment `id`; the answer says whether the Gateway still had it. */
  readonly detach: (id: AttachmentId) => Effect.Effect<Detached, GatewayAdminError>;
  /** The attachments in force on the Gateway, for every Worker behind it. */
  readonly list: Effect.Effect<AttachmentList, GatewayAdminError>;
}

/**
 * How long one admin request may take. A publish holds the Attempt's scope
 * open while it runs, so a request that never answers must end.
 */
const ADMIN_REQUEST_TIMEOUT = "30 seconds";

/** Why an admin request failed, from the failure's tag and status only. */
const reason = (failure: { readonly _tag: string }): string => {
  if (HttpClientError.isHttpClientError(failure))
    return failure.response === undefined
      ? `the admin API did not answer (${failure.reason._tag})`
      : `the admin API answered with status ${String(failure.response.status)}`;
  switch (failure._tag) {
    case "TimeoutError":
      return `the admin API did not answer within ${ADMIN_REQUEST_TIMEOUT}`;
    case "Unauthorized":
      return "the Gateway refused the admin token";
    case "AttachmentAlreadyExpired":
      return "the token had already expired";
    case "AttachmentConflict":
      return "the attachment id belongs to another Worker or repository";
    case "SchemaError":
      return "the admin API's answer did not match its contract";
    default:
      return `the request failed with ${failure._tag}`;
  }
};

/**
 * The admin API client for the Gateway in front of `worker`, sending the
 * admin token as a bearer token on every request.
 */
export const gatewayAdminFor = Effect.fn("SshExecutor.gatewayAdminFor")(function* (
  worker: WorkerName,
  gateway: SshWorkerGateway,
) {
  const client = yield* HttpApiClient.make(GatewayAdminApi, {
    baseUrl: gateway.adminUrl,
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(gateway.adminToken)),
  });
  const bounded =
    (operation: GatewayAdminOperation) =>
    <A, E extends { readonly _tag: string }>(
      request: Effect.Effect<A, E>,
    ): Effect.Effect<A, GatewayAdminError> =>
      request.pipe(
        Effect.timeout(ADMIN_REQUEST_TIMEOUT),
        Effect.mapError(
          (failure) =>
            new GatewayAdminError({
              worker,
              operation,
              message: `Could not ${operation} on the Gateway admin API at ${gateway.adminUrl.href} for Worker ${worker}: ${reason(failure)}`,
            }),
        ),
      );
  return {
    attach: (request) => bounded("attach")(client.attachments.attach({ payload: request })),
    renew: (id, request) =>
      bounded("renew")(client.attachments.renew({ params: { id }, payload: request })),
    detach: (id) => bounded("detach")(client.attachments.detach({ params: { id } })),
    list: bounded("list")(client.attachments.list()),
  } satisfies GatewayAdmin;
});
