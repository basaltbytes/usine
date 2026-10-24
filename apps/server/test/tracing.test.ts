import { createServer } from "node:http";
import { NodeServices } from "@effect/platform-node";
import { Tracing } from "@usine/config/factory";
import { Effect, Layer, Logger, Option, Schema, Tracer } from "effect";
import { assert, describe, it } from "vitest";
import { tracingLayer } from "../src/tracing.ts";

interface ReceivedRequest {
  readonly path: string | undefined;
  readonly contentType: string | undefined;
  readonly body: Buffer;
}

/**
 * Starts an OTLP receiver on a free loopback port that records every request it gets and answers
 * with `status`.
 */
const startCollector = async (status = 200) => {
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(
    server.address(),
  );
  return {
    received,
    url: new URL(`http://127.0.0.1:${port}/v1/traces`),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

const currentTracer = Effect.gen(function* () {
  return yield* Tracer.Tracer;
});

const annotated = Effect.fn("Test.annotated")(function* () {
  yield* Effect.annotateCurrentSpan({ runId: "run-279" });
});

/** Runs `effect` with span export to `tracing`, then closes the scope, which flushes the spans. */
const withSpanExport = <A>(tracing: Tracing, effect: Effect.Effect<A>, logs: Array<string> = []) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(Layer.build(tracingLayer(Option.some(tracing))), (context) =>
        Effect.provideContext(effect, context),
      ),
    ).pipe(
      Effect.withLogger(Logger.make(({ message }) => logs.push(JSON.stringify(message)))),
      Effect.provide(NodeServices.layer),
    ),
  );

describe("tracingLayer", () => {
  it("keeps the default tracer without a tracing block", async () => {
    const [fallback, provided] = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(tracingLayer(Option.none()));
          return [yield* currentTracer, yield* Effect.provideContext(currentTracer, context)];
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
    assert.strictEqual(provided, fallback);
  });

  it("exports ended spans with their names and attributes as OTLP protobuf", async () => {
    const collector = await startCollector();
    try {
      await withSpanExport(
        new Tracing({ otlpUrl: collector.url, serviceName: "usine-test" }),
        annotated(),
      );
      assert.lengthOf(collector.received, 1);
      const [request] = collector.received;
      assert.strictEqual(request?.path, "/v1/traces");
      assert.strictEqual(request?.contentType, "application/x-protobuf");
      const body = request?.body.toString("utf8") ?? "";
      for (const text of ["service.name", "usine-test", "Test.annotated", "runId", "run-279"]) {
        assert.include(body, text);
      }
    } finally {
      await collector.close();
    }
  });

  it("logs the collector URL without its credentials or query string", async () => {
    const collector = await startCollector(400);
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
        return new Tracing({ otlpUrl: url, serviceName: "usine-test" }, { disableChecks: true });
      };

      const startup: Array<string> = [];
      await withSpanExport(withSecrets(true), Effect.void, startup);
      // fetch refuses a URL with credentials, so the failed export runs without them.
      const failure: Array<string> = [];
      await withSpanExport(withSecrets(false), annotated(), failure);

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
      await collector.close();
    }
  });
});
