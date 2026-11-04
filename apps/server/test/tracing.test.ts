import { jsonKey } from "@usine/core/json-key";
// The Node server adapter requires native HTTP server and connection types.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createServer } from "node:http";
import { NodeServices } from "@effect/platform-node";
import { Tracing } from "@usine/config/factory";
import {
  ConfigProvider,
  Effect,
  Layer,
  Logger,
  Option,
  Redacted,
  Schema,
  Tracer,
  Deferred,
} from "effect";
import { HttpRouter } from "effect/http";
import { assert, describe, it } from "@effect/vitest";
import { authenticatedRoutes } from "../src/auth/http.ts";
import { tracingLayer } from "../src/tracing.ts";
import { authFixture } from "./auth/fixture.ts";

interface ReceivedRequest {
  readonly path: string | undefined;
  readonly contentType: string | undefined;
  readonly body: Buffer;
}

/**
 * Starts an OTLP receiver on a free loopback port that records every request it gets and answers
 * with `status`.
 */
const startCollector = (status = 200) =>
  Effect.gen(function* () {
    const received: Array<ReceivedRequest> = [];
    const server = createServer((request, response) => {
      const chunks: Array<Buffer> = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({
          path: request.url,
          contentType: request.headers["content-type"],
          body: Buffer.concat(chunks),
        });
        response.writeHead(status).end();
      });
    });
    yield* (() => {
      const completion = Deferred.makeUnsafe<void>();
      const resolve = (value: void) => {
        Deferred.doneUnsafe(completion, Effect.succeed(value));
      };
      server.listen(0, "127.0.0.1", resolve);
      return Deferred.await(completion);
    })();
    const { port } = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Finite }))(
      server.address(),
    );
    return {
      received,
      url: new URL(`http://127.0.0.1:${port}/v1/traces`),
      close: () =>
        (() => {
          const completion = Deferred.makeUnsafe<void>();
          const resolve = () => {
            Deferred.doneUnsafe(completion, Effect.void);
          };
          server.close(resolve);
          return Deferred.await(completion);
        })(),
    };
  });

const currentTracer = Tracer.Tracer;

const annotated = Effect.fn("Test.annotated")(function* () {
  yield* Effect.annotateCurrentSpan({ runId: "run-279" });
});

interface SpanExportOptions {
  readonly logs?: Array<string>;
  /** The process environment; empty by default. */
  readonly environment?: Record<string, string>;
}

/** Runs `effect` with span export to `tracing`, then closes the scope, which flushes the spans. */
const withSpanExport = <A, E>(
  tracing: Tracing,
  effect: Effect.Effect<A, E>,
  options?: SpanExportOptions,
) => Effect.runPromise(spanExport(tracing, effect, options));

/** The effect that `withSpanExport` runs. */
const spanExport = <A, E>(
  tracing: Tracing,
  effect: Effect.Effect<A, E>,
  options: SpanExportOptions = {},
) =>
  Effect.scoped(
    Effect.flatMap(Layer.build(tracingLayer(Option.some(tracing))), (context) =>
      Effect.provideContext(effect, context),
    ),
  ).pipe(
    Effect.withLogger(Logger.make(({ message }) => options.logs?.push(jsonKey(message)))),
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromEnv({ env: options.environment ?? {} })).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

describe("tracingLayer", () => {
  it.live(
    "redacts OAuth credentials in exported HTTP spans for rejected and successful callbacks",
    () =>
      Effect.gen(function* () {
        const collector = yield* startCollector();
        const secrets = ["unspent-code", "invalid-state", "exchanged-code", "signed-url-secret"];
        try {
          yield* Effect.promise(() =>
            withSpanExport(
              Tracing.make({ otlpUrl: collector.url, serviceName: "usine-test" }),
              Effect.gen(function* () {
                const services = yield* authFixture();
                const app = HttpRouter.toWebHandler(authenticatedRoutes(services).routes);
                yield* Effect.addFinalizer(() => Effect.promise(() => app.dispose()));
                const context = yield* Effect.context<never>();
                const rejected = yield* Effect.promise(() =>
                  app.handler(
                    new Request(
                      "https://usine.example/api/auth/callback?code=unspent-code&%73tate=invalid-state&Signature=signed-url-secret&display=kept",
                    ),
                    context,
                  ),
                );
                assert.include(
                  rejected.headers.get("location") ?? "",
                  "could%20not%20be%20verified",
                );
                const started = yield* services.authentication.startWeb(false);
                const state = Redacted.value(started.state);
                secrets.push(state);
                const accepted = yield* Effect.promise(() =>
                  app.handler(
                    new Request(
                      `https://usine.example/%61pi/auth/callback?code=exchanged-code&state=${state}`,
                      { headers: { cookie: `usine_sign_in_state=${state}` } },
                    ),
                    context,
                  ),
                );
                assert.equal(accepted.headers.get("location"), "/");
              }).pipe(Effect.scoped),
            ),
          );
          const exported = Buffer.concat(collector.received.map(({ body }) => body)).toString(
            "utf8",
          );
          for (const attribute of [
            "url.full",
            "url.query",
            "display=kept",
            "code=REDACTED",
            "state=REDACTED",
          ])
            assert.include(exported, attribute);
          for (const secret of secrets) assert.notInclude(exported, secret);
        } finally {
          yield* collector.close();
        }
      }),
  );

  it.live("keeps the default tracer without a tracing block", () =>
    Effect.gen(function* () {
      const [fallback, provided] = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(tracingLayer(Option.none()));
          return [yield* currentTracer, yield* Effect.provideContext(currentTracer, context)];
        }),
      ).pipe(Effect.provide(NodeServices.layer));
      assert.strictEqual(provided, fallback);
    }),
  );

  it.live("exports ended spans with their names and attributes as OTLP protobuf", () =>
    Effect.gen(function* () {
      const collector = yield* startCollector();
      try {
        yield* Effect.promise(() =>
          withSpanExport(
            Tracing.make({ otlpUrl: collector.url, serviceName: "usine-test" }),
            annotated(),
            {
              environment: {
                OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=eu%2Dwest,service.name=ignored",
              },
            },
          ),
        );
        assert.lengthOf(collector.received, 1);
        const [request] = collector.received;
        assert.strictEqual(request?.path, "/v1/traces");
        assert.strictEqual(request?.contentType, "application/x-protobuf");
        const body = request?.body.toString("utf8") ?? "";
        for (const text of [
          "service.name",
          "usine-test",
          "deployment.environment",
          "eu-west",
          "Test.annotated",
          "runId",
          "run-279",
        ]) {
          assert.include(body, text);
        }
        assert.notInclude(body, "ignored");
      } finally {
        yield* collector.close();
      }
    }),
  );

  it.live("refuses a malformed OTEL_RESOURCE_ATTRIBUTES and names the key at fault", () =>
    Effect.gen(function* () {
      const collector = yield* startCollector();
      try {
        const error = yield* Effect.flip(
          spanExport(
            Tracing.make({ otlpUrl: collector.url, serviceName: "usine-test" }),
            annotated(),
            {
              environment: { OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=eu,team=100%" },
            },
          ),
        );
        assert.strictEqual(error._tag, "ResourceAttributesError");
        if (error._tag !== "ResourceAttributesError") return;
        assert.strictEqual(error.variable, "OTEL_RESOURCE_ATTRIBUTES");
        assert.include(error.message, "Expected a valid URI component");
        assert.include(error.message, '["team"]');
        assert.lengthOf(collector.received, 0);
      } finally {
        yield* collector.close();
      }
    }),
  );

  it.live("logs the collector URL without its credentials or query string", () =>
    Effect.gen(function* () {
      const collector = yield* startCollector(400);
      try {
        const collectorUrl = collector.url.href;
        const withSecrets = (credentials: boolean) => {
          const url = new URL(collectorUrl);
          if (credentials) {
            url.username = "user";
            url.password = "secret";
          }
          url.search = "?token=secret";
          // usine.yaml rejects such a URL; the logs must not leak one that arrives another way.
          return Tracing.make({ otlpUrl: url, serviceName: "usine-test" }, { disableChecks: true });
        };

        const startup: Array<string> = [];
        yield* Effect.promise(() =>
          withSpanExport(withSecrets(true), Effect.void, { logs: startup }),
        );
        // fetch refuses a URL with credentials, so the failed export runs without them.
        const failure: Array<string> = [];
        yield* Effect.promise(() =>
          withSpanExport(withSecrets(false), annotated(), { logs: failure }),
        );

        const logs = [...startup, ...failure];
        assert.isTrue(startup.some((line) => line.includes("Exporting spans over OTLP")));
        assert.isTrue(
          failure.some(
            (line) =>
              line.includes("Span export to the OTLP collector failed") &&
              line.includes('"status":400'),
          ),
        );
        for (const line of logs.filter((line) => line.includes("otlpUrl"))) {
          assert.include(line, `"otlpUrl":"${collectorUrl}"`);
        }
        for (const line of logs) {
          assert.notInclude(line, "secret");
          assert.notInclude(line, "user");
        }
      } finally {
        yield* collector.close();
      }
    }),
  );
});
