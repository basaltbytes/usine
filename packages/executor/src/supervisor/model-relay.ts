import type { GatewayLlmProtocol } from "@usine/core/worker";
import { CALLER_CREDENTIAL_HEADERS } from "@usine/gateway/admin";
import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import type { GatewayModelRoute } from "../ssh/gateway/model-route.ts";

/** The model requests that the relay forwards, by request path, as the gateway serves them. */
const relayedPaths: ReadonlyMap<string, GatewayLlmProtocol> = new Map([
  ["/anthropic-messages/v1/messages", "anthropic-messages"],
  ["/openai-responses/v1/responses", "openai-responses"],
]);

/**
 * Request headers that the route replaces, which are every header that the gateway reads a caller
 * credential from, and headers that describe one connection rather than the request.
 */
const requestOnlyHeaders: ReadonlySet<string> = new Set([
  ...CALLER_CREDENTIAL_HEADERS,
  "host",
  "connection",
  "keep-alive",
  "content-length",
  "transfer-encoding",
]);

/** Response headers that describe the route's connection, which the relay's own response sets. */
const connectionHeaders = new Set(["connection", "keep-alive", "transfer-encoding"]);

const refusal = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ error: { type: "usine_model_relay", message } }, { status });

/**
 * Answers a model request from a supervisor session through `route`, the model route that the
 * instance already uses. It forwards only the model calls that the gateway serves, without the
 * session's credential headers: the route adds the instance's credential, which never enters the
 * sandbox. Any other request is refused with 404.
 */
export const relayModelRequest = Effect.fn("SupervisorModelRelay.request")(
  function* (route: GatewayModelRoute) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const path = new URL(request.url, "http://model-relay").pathname;
    const protocol = request.method === "POST" ? relayedPaths.get(path) : undefined;
    if (protocol === undefined) {
      yield* Effect.logWarning("The supervisor model relay refused a request", {
        method: request.method,
        path,
      });
      return refusal(404, `The model relay serves POST ${[...relayedPaths.keys()].join(", ")}`);
    }
    const body = yield* request.text;
    const headers = Object.fromEntries(
      Object.entries(request.headers).filter(([name]) => !requestOnlyHeaders.has(name)),
    );
    const response = yield* route.request(protocol, body, headers);
    yield* Effect.logDebug("The supervisor model relay forwarded a request", {
      protocol,
      status: response.status,
    });
    const kept = new Headers();
    response.headers.forEach((value, name) => {
      if (!connectionHeaders.has(name)) kept.append(name, value);
    });
    return HttpServerResponse.fromWeb(
      new Response(response.body, { status: response.status, headers: kept }),
    );
  },
  (effect) =>
    effect.pipe(
      Effect.catchTags({
        GatewayModelError: (error) =>
          Effect.logWarning("The supervisor model relay could not reach the model route", {
            message: error.message,
          }).pipe(Effect.as(refusal(502, error.message))),
        HttpServerError: (error) =>
          Effect.logWarning("The supervisor model relay could not read a request", {
            message: error.message,
          }).pipe(Effect.as(refusal(400, "The model relay could not read the request body"))),
      }),
    ),
);
