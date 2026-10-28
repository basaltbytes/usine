import { NodeHttpClient } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

/** Keeps client spans without sending trace headers to external services. */
const withoutTracePropagation = (transport: Layer.Layer<HttpClient.HttpClient>) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.map(
      HttpClient.HttpClient,
      HttpClient.transform((send) =>
        Effect.provideService(send, HttpClient.TracerPropagationEnabled, false),
      ),
    ),
  ).pipe(Layer.provide(transport));

export const externalHttpClientLayer = withoutTracePropagation(FetchHttpClient.layer);

/** Preserves the explicit Host header used to probe a gateway by its tailnet address. */
export const sshHttpClientLayer = withoutTracePropagation(NodeHttpClient.layerNodeHttp);
