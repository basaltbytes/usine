import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

/**
 * The fetch HTTP client for GitHub and the Gateways' admin APIs. Each request still gets a client
 * span, but no `traceparent` or `b3` header, because neither service joins usine's traces.
 */
export const externalHttpClientLayer = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(
    HttpClient.HttpClient,
    HttpClient.transform((response) =>
      Effect.provideService(response, HttpClient.TracerPropagationEnabled, false),
    ),
  ),
).pipe(Layer.provide(FetchHttpClient.layer));
