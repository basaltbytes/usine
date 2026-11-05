import { assert, it } from "@effect/vitest";
import { jsonKey } from "@usine/core/json-key";
import { RepositoryName } from "@usine/core/repository";
import { WorkerName } from "@usine/core/worker";
import { Attachments, GatewayProxy } from "@usine/gateway";
import { Deferred, Effect, Fiber, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse, HttpServerRequest, HttpServerResponse } from "effect/http";
import { gatewayModelRouteFor } from "../../../src/ssh/gateway/model-route.ts";
import { fakeMachine } from "../support.ts";
import { advance, fakeGateway, gatewayAddress } from "./support.ts";

it.effect("refuses startup when the gateway model proxy does not answer", () => {
  const machine = fakeMachine();
  return Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const settings = gatewayAddress().gateway;
    assert(Option.isSome(settings));
    const route = yield* gatewayModelRouteFor(
      WorkerName.make("coordinator-timeout"),
      RepositoryName.make("usine/coordinator"),
      settings.value,
    ).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        ),
      ),
      Effect.flip,
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust("31 seconds");
    const failure = yield* Fiber.join(route);
    assert.strictEqual(failure._tag, "GatewayModelError");
    assert.include(failure.message, "TimeoutError");
  }).pipe(Effect.provide(machine.layer), Effect.scoped);
});

it.effect(
  "keeps an orchestrator attachment renewable, swaps its caller token, and detaches on shutdown",
  () => {
    const machine = fakeMachine();
    const gateway = fakeGateway(machine);
    const upstream: Array<{ path: string; headers: Readonly<Record<string, string>> }> = [];
    const proxy = GatewayProxy.layer.pipe(
      Layer.provide(
        Layer.succeed(HttpClient.HttpClient)(
          HttpClient.make((request) => {
            upstream.push({ path: request.url, headers: request.headers });
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response("gateway model answer")),
            );
          }),
        ),
      ),
      Layer.provide(gateway.layer),
    );
    const transport = Layer.effect(
      HttpClient.HttpClient,
      Effect.gen(function* () {
        const admin = yield* HttpClient.HttpClient;
        const modelProxy = yield* GatewayProxy;
        return HttpClient.make((request) =>
          request.headers.host === "llm.gw.test"
            ? modelProxy.handle.pipe(
                Effect.provideService(
                  HttpServerRequest.HttpServerRequest,
                  HttpServerRequest.fromClientRequest(request),
                ),
                Effect.map((response) =>
                  HttpServerResponse.toClientResponse(response, { request }),
                ),
              )
            : admin.execute(request),
        );
      }),
    ).pipe(Layer.provideMerge(gateway.layer), Layer.provide(proxy));
    return Effect.gen(function* () {
      const store = yield* Attachments;
      const settings = gatewayAddress().gateway;
      assert(Option.isSome(settings));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const route = yield* gatewayModelRouteFor(
            WorkerName.make("coordinator-test"),
            RepositoryName.make("usine/coordinator"),
            settings.value,
          );
          const anthropic = yield* route.credential("anthropic-messages");
          const openai = yield* route.credential("openai-responses");
          assert.deepStrictEqual(anthropic, Option.some("api-key"));
          assert.deepStrictEqual(openai, Option.none());
          const first = yield* store.list;
          assert.lengthOf(first, 1);
          assert.strictEqual(first[0]?.credential._tag, "AnonymousCredential");
          const answer = yield* route.request(
            "anthropic-messages",
            '{"model":"claude-sonnet-4-6"}',
            {
              authorization: "Bearer local-login-must-not-escape",
              "x-api-key": "local-api-key-must-not-escape",
              "chatgpt-account-id": "local-account",
            },
          );
          const text = yield* Effect.promise(() => answer.text());
          assert.strictEqual(text, "gateway model answer");
          assert.lengthOf(upstream, 1);
          assert.strictEqual(upstream[0]?.headers["x-api-key"], "sk-ant-api03-for-executor-tests");
          assert.isUndefined(upstream[0]?.headers.authorization);
          assert.notInclude(jsonKey(upstream), "local-");
          assert.notInclude(jsonKey(upstream), "ugw1.");
          const [attachment] = first;
          assert(attachment !== undefined);
          yield* store.detach(attachment.id);
          yield* advance(gateway, 3);
          const restored = yield* store.list;
          assert.strictEqual(restored[0]?.id, first[0]?.id);
          const renewed = yield* route.request("anthropic-messages", "{}", {});
          assert.strictEqual(renewed.status, 200);
          yield* Effect.promise(() => renewed.text());
        }),
      );
      const remaining = yield* store.list;
      assert.lengthOf(remaining, 0);
      assert(machine.state.forwards.every(({ live }) => !live));
    }).pipe(Effect.provide(transport.pipe(Layer.provideMerge(machine.layer))), Effect.scoped);
  },
);
