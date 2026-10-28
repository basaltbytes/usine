import { createServer, type IncomingHttpHeaders } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { externalHttpClientLayer, sshHttpClientLayer } from "../src/http-client.ts";

describe("External HTTP client", () => {
  it.live("preserves the gateway Host header over HTTP without propagating trace headers", () =>
    Effect.gen(function* () {
      const received: Array<IncomingHttpHeaders> = [];
      const server = yield* NodeHttpServer.make(
        () =>
          createServer((request, response) => {
            received.push(request.headers);
            const knownHost = request.headers.host === "git.gw.test";
            response.writeHead(knownHost ? 401 : 404, {
              "x-usine-gateway-refusal": knownHost ? "missing-caller-token" : "unknown-host",
            });
            response.end();
          }),
        { host: "127.0.0.1", port: 0 },
      );
      assert(server.address._tag !== "UnixPathAddress");
      const client = yield* HttpClient.HttpClient;
      const response = yield* client
        .execute(
          HttpClientRequest.get(`http://127.0.0.1:${server.address.port}/`).pipe(
            HttpClientRequest.setHeader("host", "git.gw.test"),
          ),
        )
        .pipe(Effect.withSpan("Test.gatewayPreflight"));
      assert.lengthOf(received, 1);
      assert.strictEqual(received[0]?.host, "git.gw.test");
      assert.strictEqual(received[0]?.traceparent, undefined);
      assert.strictEqual(received[0]?.b3, undefined);
      assert.strictEqual(response.status, 401);
      assert.strictEqual(response.headers["x-usine-gateway-refusal"], "missing-caller-token");
    }).pipe(
      Effect.scoped,
      // The runtime also builds the fetch client in this layer scope.
      Effect.provide(sshHttpClientLayer.pipe(Layer.provide(externalHttpClientLayer))),
    ),
  );

  it.effect("sends no trace headers to GitHub or a Gateway, even inside a span", () => {
    const sent: Array<Headers> = [];
    const recordingFetch: typeof globalThis.fetch = async (_input, init) => {
      sent.push(new Headers(init?.headers));
      return new Response("{}", { status: 200 });
    };
    return Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      yield* client.get("https://api.github.com/zen").pipe(Effect.withSpan("Test.pollCycle"));
      assert.lengthOf(sent, 1);
      assert.isFalse(sent[0]?.has("traceparent"));
      assert.isFalse(sent[0]?.has("b3"));
    }).pipe(
      Effect.provide(externalHttpClientLayer),
      Effect.provideService(FetchHttpClient.Fetch, recordingFetch),
    );
  });
});
