// Node clients exercise the relay's HTTP connection and streaming boundaries.
// @effect-diagnostics asyncFunction:off
// @effect-diagnostics newPromise:off
import { connect } from "node:net";
import { NodeHttpClient, NodeHttpServer, NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { MessageSizeMib, SupervisorLimits } from "@usine/core/worker";
import { ModelId } from "@usine/core/agent/brain";
import { Effect, Logger, Result, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpServerRequest, HttpServerResponse } from "effect/http";
import { GatewayModelError, type GatewayModelRoute } from "../../src/ssh/gateway/model-route.ts";
import {
  modelRelayServer,
  MAX_RELAY_CONNECTIONS,
  relayModelRequest,
} from "../../src/supervisor/model-relay.ts";

const limits = SupervisorLimits.make({ modelRequestMib: MessageSizeMib.make(2) });
const MAX_RELAY_BODY_BYTES = 2 * 1024 ** 2;
const model = ModelId.make("allowed");
const unused: GatewayModelRoute = {
  credential: () => Effect.succeedNone,
  request: () => Effect.die("A refused request must not reach the gateway"),
};
const request = (body: string) =>
  HttpServerRequest.fromWeb(
    new Request("http://relay/openai-responses/v1/responses", { method: "POST", body }),
  );

describe("supervisor relay limits", () => {
  it.effect("logs refused paths, invalid and unreadable bodies, models and body sizes", () => {
    const logs: Array<unknown> = [];
    const logger = Logger.layer([
      Logger.make<unknown, void>(({ logLevel, message }) => {
        if (logLevel === "Warn") logs.push(message);
      }),
    ]);
    return Effect.gen(function* () {
      const broken = {
        method: "POST",
        duplex: "half",
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("broken stream"));
          },
        }),
      };
      const requests = [
        HttpServerRequest.fromWeb(new Request("http://relay/unknown")),
        request("invalid"),
        HttpServerRequest.fromWeb(
          new Request("http://relay/openai-responses/v1/responses", broken),
        ),
        request('{"model":"other"}'),
        request("x".repeat(MAX_RELAY_BODY_BYTES + 1)),
      ];
      const statuses = yield* Effect.forEach(requests, (request) =>
        relayModelRequest(unused, model, limits).pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, request),
          Effect.map((response) => response.status),
        ),
      );
      assert.deepStrictEqual(statuses, [404, 400, 400, 403, 413]);
      assert.deepStrictEqual(logs, [
        ["The supervisor model relay refused a path", { method: "GET", path: "/unknown" }],
        ["The supervisor model relay refused an invalid JSON model request", { bytes: 7 }],
        ["The supervisor model relay could not read the request body"],
        ["The supervisor model relay refused another model", { requestedModel: "other", model }],
        [
          "The supervisor model relay refused an oversized body",
          { bytes: MAX_RELAY_BODY_BYTES + 1 },
        ],
      ]);
    }).pipe(Effect.provide(logger));
  });

  it.effect("refuses another model and hides the gateway destination in a 502", () =>
    Effect.gen(function* () {
      const denied = yield* relayModelRequest(unused, model, limits).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request('{"model":"other"}')),
      );
      assert.strictEqual(denied.status, 403);
      const failed = yield* relayModelRequest(
        {
          credential: () => Effect.succeedNone,
          request: () =>
            Effect.fail(
              GatewayModelError.make({ message: "Failed to connect to secret.gateway:3210" }),
            ),
        },
        model,
      ).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request('{"model":"allowed"}')),
      );
      assert.strictEqual(failed.status, 502);
      const body = yield* Effect.promise(() => HttpServerResponse.toWeb(failed).text());
      assert.notInclude(body, "secret.gateway");
    }),
  );

  it.live("returns 413 while streaming and stops reading the oversized body", () =>
    Effect.gen(function* () {
      const server = yield* NodeHttpServer.make(modelRelayServer, {
        host: "127.0.0.1",
        port: 0,
      });
      yield* server.serve(relayModelRequest(unused, model, limits));
      const address = server.address;
      assert(address._tag === "InetAddressV4");
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(
        HttpClientRequest.post(
          `http://127.0.0.1:${address.port}/openai-responses/v1/responses`,
        ).pipe(HttpClientRequest.bodyText("x".repeat(MAX_RELAY_BODY_BYTES + 1))),
      );
      assert.strictEqual(response.status, 413);
      let pulls = 0;
      let cancelled = false;
      const init = {
        method: "POST",
        duplex: "half",
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls++;
            controller.enqueue(new Uint8Array(64 * 1024));
            if (pulls === 128) controller.close();
          },
          cancel() {
            cancelled = true;
          },
        }),
      };
      const bounded = yield* relayModelRequest(unused, model, limits).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request("http://relay/openai-responses/v1/responses", init),
          ),
        ),
      );
      assert.strictEqual(bounded.status, 413);
      assert.isBelow(pulls, 36);
      assert.isTrue(cancelled);
    }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, NodeHttpClient.layerUndici])),
  );

  it.effect("forwards bodies above 2 MiB with the configured allowance", () =>
    Effect.gen(function* () {
      const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
        model,
        input: "x".repeat(3 * 1024 ** 2),
      });
      const route: GatewayModelRoute = {
        credential: () => Effect.succeedNone,
        request: (_protocol, received) =>
          Effect.sync(() => {
            assert.strictEqual(received, body);
            return new Response("ok");
          }),
      };
      for (const configured of [
        SupervisorLimits.make({}),
        SupervisorLimits.make({ modelRequestMib: MessageSizeMib.make(4) }),
      ]) {
        const response = yield* relayModelRequest(route, model, configured).pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, request(body)),
        );
        assert.strictEqual(response.status, 200);
      }
    }),
  );

  it("drops connections above the limit", async () => {
    const server = modelRelayServer();
    const sockets: Array<ReturnType<typeof connect>> = [];
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const decoded = Schema.decodeUnknownResult(Schema.Struct({ port: Schema.Int }))(
        server.address(),
      );
      assert(Result.isSuccess(decoded));
      const address = decoded.success;
      for (let i = 0; i < MAX_RELAY_CONNECTIONS; i++) {
        const socket = connect(address.port, "127.0.0.1");
        sockets.push(socket);
        await new Promise<void>((resolve, reject) => {
          socket.once("connect", resolve);
          socket.once("error", reject);
        });
      }
      const excess = connect(address.port, "127.0.0.1");
      sockets.push(excess);
      await new Promise<void>((resolve, reject) => {
        excess.setTimeout(1000, () => excess.destroy(new Error("Excess connection remained open")));
        excess.once("close", () => resolve());
        excess.once("error", reject);
      });
      const connections = await new Promise<number>((resolve, reject) =>
        server.getConnections((error, count) => (error !== null ? reject(error) : resolve(count))),
      );
      assert.strictEqual(connections, MAX_RELAY_CONNECTIONS);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
