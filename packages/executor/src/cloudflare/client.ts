import {
  ACCESS_CLIENT_ID_HEADER,
  ACCESS_CLIENT_SECRET_HEADER,
  type CreateSandbox,
  type Destroyed,
  type HealthReport,
  SandboxApi,
  type SandboxCredentials,
  type SandboxList,
  type SandboxName,
  type SandboxOwner,
  type SandboxSummary,
  type Stopped,
} from "@usine/cloudflare";
import { WorkerName } from "@usine/core/worker";
import { Effect, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import type { CloudflareWorkerAddress } from "./model.ts";

export const SandboxOperation = Schema.Literals([
  "health",
  "create",
  "get",
  "list",
  "credentials",
  "hold",
  "stop",
  "destroy",
]);
export type SandboxOperation = typeof SandboxOperation.Type;

const ACTIONS = {
  health: "check the Worker's health",
  create: "create the sandbox",
  get: "read the sandbox",
  list: "list the sandboxes",
  credentials: "renew the sandbox's credentials",
  hold: "hold the sandbox",
  stop: "stop the sandbox's commands",
  destroy: "destroy the sandbox",
} as const satisfies Record<SandboxOperation, string>;

/**
 * A failed request to the Worker. `message` contains no credential; the request and raw failure
 * are discarded because create and credential requests contain the installation token and the
 * provider keys.
 */
export class SandboxRequestError extends Schema.TaggedError<SandboxRequestError>(
  "@usine/executor/SandboxRequestError",
)("SandboxRequestError", {
  worker: WorkerName,
  operation: SandboxOperation,
  /** Whether the Worker refused the Access service token. */
  refused: Schema.Boolean,
  message: Schema.NonEmptyString,
}) {}

/** The timeout for one request. Creating a sandbox starts its container. */
const REQUEST_TIMEOUT = "2 minutes";

/** Returns the failure reason, built only from the failure's tag, status, and typed fields. */
const reason = (failure: { readonly _tag: string }): string => {
  if (HttpClientError.isHttpClientError(failure))
    return failure.response === undefined
      ? `no response (${failure.reason._tag})`
      : failure.response.status === 401
        ? "the Worker refused the Access service token"
        : `the Worker returned status ${String(failure.response.status)}`;
  switch (failure._tag) {
    case "TimeoutError":
      return `no response within ${REQUEST_TIMEOUT}`;
    case "SandboxNotFound":
      return "the sandbox doesn't exist";
    case "SandboxConflict":
      return "the sandbox exists for another Attempt";
    case "StaleCredentials":
      return "the sandbox holds credentials that usine issued later";
    case "ImageNotFound":
      return "the Worker has no image with that name";
    case "ContainerUnavailable":
      return "the sandbox's container isn't running or failed the request";
    case "SchemaError":
      return "the Worker's response doesn't match its schema";
    default:
      return `the request failed with ${failure._tag}`;
  }
};

const refusedToken = (failure: { readonly _tag: string }): boolean =>
  HttpClientError.isHttpClientError(failure) && failure.response?.status === 401;

/** The sandbox API of one deployed Worker. Every method fails with `SandboxRequestError`. */
export interface SandboxClient {
  readonly health: Effect.Effect<HealthReport, SandboxRequestError>;
  readonly create: (
    name: SandboxName,
    request: CreateSandbox,
  ) => Effect.Effect<SandboxSummary, SandboxRequestError>;
  /** Returns `None` if the sandbox doesn't exist. */
  readonly get: (
    name: SandboxName,
  ) => Effect.Effect<Option.Option<SandboxSummary>, SandboxRequestError>;
  /** Lists the sandboxes of this usine instance and Worker. */
  readonly list: Effect.Effect<SandboxList, SandboxRequestError>;
  readonly credentials: (
    name: SandboxName,
    credentials: SandboxCredentials,
  ) => Effect.Effect<SandboxSummary, SandboxRequestError>;
  /** Keeps the sandbox's container running past its lease, until it's destroyed. */
  readonly hold: (name: SandboxName) => Effect.Effect<SandboxSummary, SandboxRequestError>;
  readonly stop: (name: SandboxName) => Effect.Effect<Stopped, SandboxRequestError>;
  readonly destroy: (name: SandboxName) => Effect.Effect<Destroyed, SandboxRequestError>;
}

/**
 * Returns the client for `address`'s Worker, which sends the Access service token with each
 * request and lists only `owner`'s sandboxes.
 */
export const sandboxClientFor = Effect.fn("CloudflareExecutor.sandboxClientFor")(function* (
  address: CloudflareWorkerAddress,
  owner: SandboxOwner,
) {
  const client = yield* HttpApiClient.make(SandboxApi, {
    baseUrl: address.workerUrl,
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.setHeaders({
        [ACCESS_CLIENT_ID_HEADER]: Redacted.value(address.accessClientId),
        [ACCESS_CLIENT_SECRET_HEADER]: Redacted.value(address.accessClientSecret),
      }),
    ),
  });
  const worker = address.name;
  const request = <A, E extends { readonly _tag: string }>(
    operation: SandboxOperation,
    effect: Effect.Effect<A, E>,
    fields: Readonly<Record<string, string>> = {},
  ) =>
    effect.pipe(
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.mapError(
        (failure) =>
          new SandboxRequestError({
            worker,
            operation,
            refused: refusedToken(failure),
            message: `Can't ${ACTIONS[operation]} for cloudflare worker "${worker}": ${reason(failure)}`,
          }),
      ),
      Effect.tapError((error) =>
        Effect.logWarning("Cloudflare Worker request failed", {
          worker,
          operation,
          message: error.message,
          ...fields,
        }),
      ),
      Effect.withSpan(`CloudflareExecutor.${operation}`, { attributes: { worker, ...fields } }),
    );
  return {
    health: request("health", client.health.health()),
    create: (name, body) =>
      request("create", client.sandbox.create({ params: { name }, payload: body }), {
        sandbox: name,
      }),
    get: (name) =>
      request(
        "get",
        client.sandbox.get({ params: { name } }).pipe(
          Effect.map(Option.some),
          Effect.catchTag("SandboxNotFound", () => Effect.succeedNone),
        ),
        { sandbox: name },
      ),
    list: request("list", client.registry.list({ query: { owner } }), { owner }),
    credentials: (name, body) =>
      request("credentials", client.sandbox.credentials({ params: { name }, payload: body }), {
        sandbox: name,
      }),
    hold: (name) => request("hold", client.sandbox.hold({ params: { name } }), { sandbox: name }),
    stop: (name) => request("stop", client.sandbox.stop({ params: { name } }), { sandbox: name }),
    destroy: (name) =>
      request("destroy", client.sandbox.destroy({ params: { name } }), { sandbox: name }),
  } satisfies SandboxClient;
});
