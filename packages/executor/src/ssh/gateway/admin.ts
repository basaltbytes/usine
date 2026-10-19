import { WorkerName } from "@usine/core/worker";
import {
  type AttachRequest,
  type Attached,
  type AttachmentId,
  type AttachmentList,
  type Detached,
  GatewayAdminApi,
} from "@usine/gateway/admin";
import { DateTime, Effect, type Redacted, Result, Schema } from "effect";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import type { SshWorkerGateway } from "../model.ts";
import { type GatewayForward, GatewayForwardClosed, type OpenForward } from "./forward.ts";

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

/** Why an admin request failed, from the forward's state or the failure's tag and status only. */
const reason = (failure: { readonly _tag: string }): string => {
  if (failure instanceof GatewayForwardClosed)
    return `the forward through ${failure.gateway} is closed since ${DateTime.formatIso(failure.since)}: ${failure.reason}`;
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

/** A request that got no answer may have met a forward whose SSH connection died before its client noticed. */
const unanswered = (failure: { readonly _tag: string }): boolean =>
  failure._tag === "TimeoutError" ||
  (HttpClientError.isHttpClientError(failure) && failure.response === undefined);

const adminClientAt = (url: URL, adminToken: Redacted.Redacted<string>) =>
  HttpApiClient.make(GatewayAdminApi, {
    baseUrl: url,
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(adminToken)),
  });

type AdminClient = Effect.Success<ReturnType<typeof adminClientAt>>;

/**
 * The admin API client for the Gateway in front of `worker`, reached through
 * the executor's `forward` and sending the admin token as a bearer token on
 * every request. A request that finds the forward closed, or gets no answer
 * through it, reopens the forward and is sent once more; a second failure is
 * the request's failure.
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
    const through = (open: OpenForward) =>
      adminClientAt(open.url, gateway.adminToken).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.flatMap(call),
        Effect.timeout(ADMIN_REQUEST_TIMEOUT),
      );
    const retried = (generation: number, failure: { readonly _tag: string }) =>
      Effect.logWarning(
        "A Gateway admin request did not get through; reopening the forward and sending it once more",
        { worker, operation, gateway: forward.gateway, generation, reason: reason(failure) },
      ).pipe(Effect.andThen(forward.reopen(generation)), Effect.flatMap(through));

    const opened = yield* Effect.result(forward.current);
    if (Result.isFailure(opened)) return yield* retried(opened.failure.generation, opened.failure);
    const answered = yield* Effect.result(through(opened.success));
    if (Result.isSuccess(answered)) return answered.success;
    if (!unanswered(answered.failure)) return yield* Effect.fail(answered.failure);
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
              message: `Could not ${operation} on the admin API of Gateway ${forward.gateway} for Worker ${worker}: ${reason(failure)}`,
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
  } satisfies GatewayAdmin;
});
