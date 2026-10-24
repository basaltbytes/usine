import type { Tracing } from "@usine/config/factory";
import { Effect, type FileSystem, Layer, Option } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { OtlpSerialization, OtlpTracer } from "effect/unstable/observability";
import { type CliVersionError, packageVersion } from "./cli.ts";

const exportClientLayer = (otlpUrl: string) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (client) =>
      client.pipe(
        HttpClient.filterStatusOk,
        HttpClient.tapError((error) =>
          Effect.logWarning("Span export to the OTLP collector failed", {
            otlpUrl,
            reason: error.reason._tag,
            message: error.message,
          }),
        ),
      ),
    ),
  ).pipe(Layer.provide(FetchHttpClient.layer));

/**
 * Exports every ended span to `tracing.otlpUrl` as OTLP/HTTP protobuf, or keeps Effect's default
 * tracer, which exports nothing, if `tracing` is `None`. Logs which of the two applies, and a
 * warning for each failed export request. A failed export, after up to 3 retries, drops the buffered
 * spans and pauses export for 60 seconds. Closing the layer's scope flushes buffered spans for at
 * most 3 seconds.
 */
export const tracingLayer = (
  tracing: Option.Option<Tracing>,
): Layer.Layer<never, CliVersionError, FileSystem.FileSystem> =>
  Option.match(tracing, {
    onNone: () =>
      Layer.effectDiscard(
        Effect.logInfo("Span export is off; set tracing.otlp_url in usine.yaml to turn it on"),
      ),
    onSome: ({ otlpUrl, serviceName }) =>
      Layer.unwrap(
        Effect.map(packageVersion(), (serviceVersion) =>
          OtlpTracer.layer({ url: otlpUrl.href, resource: { serviceName, serviceVersion } }).pipe(
            Layer.provide(OtlpSerialization.layerProtobuf),
            Layer.provide(exportClientLayer(otlpUrl.href)),
            Layer.merge(
              Layer.effectDiscard(
                Effect.logInfo("Exporting spans over OTLP", {
                  otlpUrl: otlpUrl.href,
                  serviceName,
                  serviceVersion,
                }),
              ),
            ),
          ),
        ),
      ),
  });
