import { createServer } from "node:http";
import { NodeServices } from "@effect/platform-node";
import { Tracing } from "@usine/config/factory";
import { Effect, Layer, Option, Schema, Tracer } from "effect";
import { assert, describe, it } from "vitest";
import { tracingLayer } from "../src/tracing.ts";

interface ReceivedRequest {
  readonly path: string | undefined;
  readonly contentType: string | undefined;
  readonly body: Buffer;
}

/** Starts an OTLP receiver on a free loopback port that records every request it gets. */
const startCollector = async () => {
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
      response.writeHead(200).end();
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
      const tracing = new Tracing({ otlpUrl: collector.url, serviceName: "usine-test" });
      // Closing the scope flushes the buffered span.
      await Effect.runPromise(
        Effect.scoped(
          Effect.flatMap(Layer.build(tracingLayer(Option.some(tracing))), (context) =>
            Effect.provideContext(annotated(), context),
          ),
        ).pipe(Effect.provide(NodeServices.layer)),
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
});
