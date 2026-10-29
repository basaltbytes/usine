import type { Tracing } from "@usine/config/factory";
import {
  Config,
  ConfigProvider,
  Effect,
  type FileSystem,
  Layer,
  Option,
  Schema,
  SchemaTransformation,
} from "effect";
import { FetchHttpClient, HttpClient, UrlParams } from "effect/http";
import { OtlpSerialization, OtlpTracer } from "effect/observability";
import { type CliVersionError, packageVersion } from "./cli.ts";

const RESOURCE_ATTRIBUTES = "OTEL_RESOURCE_ATTRIBUTES";

/** `OTEL_RESOURCE_ATTRIBUTES` has a key or value that isn't valid percent-encoding. */
export class ResourceAttributesError extends Schema.TaggedError<ResourceAttributesError>(
  "@usine/server/ResourceAttributesError",
)("ResourceAttributesError", {
  variable: Schema.Literal(RESOURCE_ATTRIBUTES),
  /** The parse problem, with the key at fault. */
  message: Schema.String,
}) {}

/** Comma-separated `key=value` pairs with percent-encoded keys and values. */
const ResourceAttributes = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Record(Schema.StringFromUriComponent, Schema.StringFromUriComponent),
    SchemaTransformation.splitKeyValue(),
  ),
);

/** Returns the attributes in `OTEL_RESOURCE_ATTRIBUTES`, or none if it's unset. */
const resourceAttributes = Effect.fn("Tracing.resourceAttributes")(function* () {
  const refuse = (error: { readonly message: string }) =>
    new ResourceAttributesError({ variable: RESOURCE_ATTRIBUTES, message: error.message });
  const value = yield* Config.option(Config.String(RESOURCE_ATTRIBUTES)).pipe(
    Effect.mapError(refuse),
  );
  return yield* Option.match(value, {
    onNone: () => Effect.succeed({}),
    onSome: (attributes) =>
      Schema.decodeUnknownEffect(ResourceAttributes)(attributes).pipe(Effect.mapError(refuse)),
  });
});

/** Returns the URL's origin and path, without credentials, query string, or fragment. */
const loggedUrl = (url: URL) => `${url.origin}${url.pathname}`;

const EXPORT_FAILED = "Span export to the OTLP collector failed";

// The error message is left out because it repeats the request URL.
const exportClientLayer = (collector: string) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (client) =>
      client.pipe(
        HttpClient.filterStatusOk,
        HttpClient.tapError((error) => {
          const failure = { otlpUrl: collector, reason: error.reason._tag };
          return Option.match(Option.fromUndefinedOr(error.response), {
            onNone: () => Effect.logWarning(EXPORT_FAILED, failure),
            onSome: ({ status }) => Effect.logWarning(EXPORT_FAILED, { ...failure, status }),
          });
        }),
      ),
    ),
  ).pipe(Layer.provide(FetchHttpClient.layer));

/**
 * Exports every ended span to `tracing.otlpUrl` as OTLP/HTTP protobuf, or keeps Effect's default
 * tracer, which exports nothing, if `tracing` is `None`. Logs which of the two applies, and a
 * warning for each failed export request, with the URL's origin and path only. A failed export,
 * after up to 3 retries, drops the buffered spans and pauses export for 60 seconds. Closing the
 * layer's scope flushes buffered spans for at most 3 seconds. Fails with
 * `ResourceAttributesError` if `tracing` is set and `OTEL_RESOURCE_ATTRIBUTES` is malformed.
 */
export const tracingLayer = (
  tracing: Option.Option<Tracing>,
): Layer.Layer<never, CliVersionError | ResourceAttributesError, FileSystem.FileSystem> =>
  Option.match(tracing, {
    onNone: () =>
      Layer.effectDiscard(
        Effect.logInfo("Span export is off; set tracing.otlp_url in usine.yaml to turn it on"),
      ),
    onSome: ({ otlpUrl, serviceName }) =>
      Layer.unwrap(
        Effect.gen(function* () {
          const serviceVersion = yield* packageVersion();
          const attributes = yield* resourceAttributes();
          return OtlpTracer.layer({
            url: otlpUrl.href,
            resource: { serviceName, serviceVersion, attributes },
          }).pipe(
            // `attributes` replaces the resource's own read of OTEL_RESOURCE_ATTRIBUTES, which dies on
            // a malformed value.
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
            Layer.provide(OtlpSerialization.layerProtobuf),
            Layer.provide(exportClientLayer(loggedUrl(otlpUrl))),
            Layer.merge(
              Layer.effectDiscard(
                Effect.logInfo("Exporting spans over OTLP", {
                  otlpUrl: loggedUrl(otlpUrl),
                  serviceName,
                  serviceVersion,
                }),
              ),
            ),
          );
        }),
      ),
  }).pipe(
    Layer.merge(
      Layer.effect(
        UrlParams.CurrentRedactedNames,
        Effect.map(UrlParams.CurrentRedactedNames, (names) => [...names, "code", "state"]),
      ),
    ),
  );
