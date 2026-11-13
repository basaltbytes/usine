// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createServer } from "node:http";
import type { ModelId } from "@usine/core/agent/brain";
import type { GatewayLlmProtocol } from "@usine/core/worker";
import { CALLER_CREDENTIAL_HEADERS } from "@usine/gateway/admin";
import { Effect, Result, Schema, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import type { GatewayModelRoute } from "../ssh/gateway/model-route.ts";

export const MAX_RELAY_BODY_BYTES = 2 * 1024 ** 2;
export const MAX_RELAY_CONNECTIONS = 8;

export const modelRelayServer = () => {
  const server = createServer({
    requestTimeout: 30_000,
    headersTimeout: 10_000,
    maxHeaderSize: 16_384,
  });
  server.maxConnections = MAX_RELAY_CONNECTIONS;
  return server;
};

const relayedPaths: ReadonlyMap<string, GatewayLlmProtocol> = new Map([
  ["/anthropic-messages/v1/messages", "anthropic-messages"],
  ["/openai-responses/v1/responses", "openai-responses"],
]);
const requestOnlyHeaders: ReadonlySet<string> = new Set([
  ...CALLER_CREDENTIAL_HEADERS,
  "host",
  "connection",
  "keep-alive",
  "content-length",
  "transfer-encoding",
]);
const connectionHeaders = new Set(["connection", "keep-alive", "transfer-encoding"]);
const refusal = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ error: { type: "usine_model_relay", message } }, { status });
const decodeModel = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Struct({ model: Schema.String })),
);

/** Forwards bounded requests for the configured model without caller credentials. */
export const relayModelRequest = Effect.fn("SupervisorModelRelay.request")(
  function* (route: GatewayModelRoute, model: ModelId) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const path = new URL(request.url, "http://model-relay").pathname;
    const protocol = request.method === "POST" ? relayedPaths.get(path) : undefined;
    if (protocol === undefined) return refusal(404, "The model relay serves model requests only");
    let bytes = 0;
    const chunks: Array<Uint8Array> = [];
    yield* request.stream.pipe(
      Stream.runForEachWhile((chunk) => {
        bytes += chunk.byteLength;
        if (bytes > MAX_RELAY_BODY_BYTES) return Effect.succeed(false);
        chunks.push(chunk);
        return Effect.succeed(true);
      }),
    );
    if (bytes > MAX_RELAY_BODY_BYTES) {
      yield* Effect.logWarning("The supervisor model relay refused an oversized body");
      return refusal(413, "The model request exceeds 2 MiB");
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const parsed = decodeModel(body);
    if (Result.isFailure(parsed)) return refusal(400, "Expected a JSON model request");
    if (parsed.success.model !== model) {
      yield* Effect.logWarning("The supervisor model relay refused another model");
      return refusal(403, "The model relay serves the configured supervisor model only");
    }
    const headers = Object.fromEntries(
      Object.entries(request.headers).filter(([name]) => !requestOnlyHeaders.has(name)),
    );
    const response = yield* route.request(protocol, body, headers);
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
          Effect.logWarning("The supervisor model route failed", {
            message: error.message,
          }).pipe(Effect.as(refusal(502, "The model route is unavailable"))),
        HttpServerError: () =>
          Effect.succeed(refusal(400, "The model relay could not read the request body")),
      }),
    ),
);
