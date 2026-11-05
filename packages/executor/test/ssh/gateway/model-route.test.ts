import { assert, it } from "@effect/vitest";
import { jsonKey } from "@usine/core/json-key";
import { RepositoryName } from "@usine/core/repository";
import { WorkerName } from "@usine/core/worker";
import { Attachments, GatewayProxy } from "@usine/gateway";
import { Deferred, Effect, Fiber, Layer, Logger, Option } from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse, HttpServerRequest, HttpServerResponse } from "effect/http";
import { gatewayModelRouteFor } from "../../../src/ssh/gateway/model-route.ts";
import { fakeMachine } from "../support.ts";
import { advance, fakeGateway, gatewayAddress } from "./support.ts";

const fixture = () => {
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
              Effect.map((response) => HttpServerResponse.toClientResponse(response, { request })),
            )
          : admin.execute(request),
      );
    }),
  ).pipe(Layer.provideMerge(gateway.layer), Layer.provide(proxy));
  return { machine, gateway, upstream, transport };
};

it.effect("reports the gateway model proxy probe deadline", () => {
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
    assert.strictEqual(
      failure.message,
      "The model proxy on gateway usine-gateway did not answer within 30 seconds.",
    );
  }).pipe(Effect.provide(machine.layer), Effect.scoped);
});

it.effect(
  "keeps an orchestrator attachment renewable, swaps its caller token, and detaches on shutdown",
  () => {
    const { machine, gateway, upstream, transport } = fixture();
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

it.effect.each([200, 401, 503])("refuses an unexpected model proxy probe status (%s)", (status) => {
  const machine = fakeMachine();
  return Effect.gen(function* () {
    const settings = gatewayAddress().gateway;
    assert(Option.isSome(settings));
    const failure = yield* gatewayModelRouteFor(
      WorkerName.make("coordinator-wrong-proxy"),
      RepositoryName.make("usine/coordinator"),
      settings.value,
    ).pipe(Effect.flip);
    assert.include(failure.message, "can't reach the model proxy");
  }).pipe(
    Effect.scoped,
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status }))),
      ),
    ),
    Effect.provide(machine.layer),
  );
});

it.effect("requires credential reporting from older gateways", () => {
  const { machine, gateway, transport } = fixture();
  gateway.switches.reportsProviders = false;
  return Effect.gen(function* () {
    const settings = gatewayAddress().gateway;
    assert(Option.isSome(settings));
    const route = yield* gatewayModelRouteFor(
      WorkerName.make("coordinator-old-gateway"),
      RepositoryName.make("usine/coordinator"),
      settings.value,
    );
    const failure = yield* route.credential("openai-responses").pipe(Effect.flip);
    assert.include(failure.message, "Upgrade @usine/gateway");
  }).pipe(Effect.provide(transport.pipe(Layer.provideMerge(machine.layer))), Effect.scoped);
});

it.effect("warns after a failed renewal and restores the attachment on the next cycle", () => {
  const { machine, gateway, transport } = fixture();
  const warnings: Array<unknown> = [];
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const store = yield* Attachments;
    let refuse = true;
    const intercepted = HttpClient.make((request) =>
      request.method === "PUT" && refuse
        ? Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 500 })))
        : client.execute(request),
    );
    const settings = gatewayAddress().gateway;
    assert(Option.isSome(settings));
    yield* gatewayModelRouteFor(
      WorkerName.make("coordinator-renew-failure"),
      RepositoryName.make("usine/coordinator"),
      settings.value,
    ).pipe(Effect.provideService(HttpClient.HttpClient, intercepted));
    const [attached] = yield* store.list;
    assert(attached !== undefined);
    yield* store.detach(attached.id);
    yield* advance(gateway, 3);
    const remaining = yield* store.list;
    assert.deepStrictEqual(remaining, []);
    assert.include(warnings, "Could not renew the orchestrator model route; will retry");
    refuse = false;
    yield* advance(gateway, 2);
    assert.deepStrictEqual(
      (yield* store.list).map(({ id }) => id),
      [attached.id],
    );
  }).pipe(
    Effect.provide([
      Logger.layer([
        Logger.make(({ logLevel, message }) => {
          if (logLevel === "Warn") warnings.push(Array.isArray(message) ? message[0] : message);
        }),
      ]),
      transport.pipe(Layer.provideMerge(machine.layer)),
    ]),
    Effect.scoped,
  );
});

it.effect("waits for an in-flight renewal before detaching on scope interruption", () => {
  const { machine, transport } = fixture();
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const store = yield* Attachments;
    const renewing = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const opened = yield* Deferred.make<void>();
    const intercepted = HttpClient.make((request) =>
      request.method === "PUT"
        ? Deferred.succeed(renewing, undefined).pipe(
            Effect.andThen(Deferred.await(finish)),
            Effect.andThen(client.execute(request)),
          )
        : client.execute(request),
    );
    const settings = gatewayAddress().gateway;
    assert(Option.isSome(settings));
    const running = yield* Effect.gen(function* () {
      yield* gatewayModelRouteFor(
        WorkerName.make("coordinator-renew-race"),
        RepositoryName.make("usine/coordinator"),
        settings.value,
      );
      yield* Deferred.succeed(opened, undefined);
      return yield* Effect.never;
    }).pipe(
      Effect.scoped,
      Effect.provideService(HttpClient.HttpClient, intercepted),
      Effect.forkChild,
    );
    yield* Deferred.await(opened);
    yield* TestClock.adjust("2 minutes");
    yield* Deferred.await(renewing);
    const closing = yield* Fiber.interrupt(running).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    const inFlight = yield* store.list;
    assert.lengthOf(inFlight, 1);
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(closing);
    const remaining = yield* store.list;
    assert.deepStrictEqual(remaining, []);
    assert(machine.state.forwards.every(({ live }) => !live));
  }).pipe(Effect.provide(transport.pipe(Layer.provideMerge(machine.layer))), Effect.scoped);
});

it.effect.each(["body cancellation", "signal abort"])(
  "aborts the model HTTP request on %s",
  (mode) => {
    const { machine, transport } = fixture();
    const controller = new AbortController();
    return Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const aborted = yield* Deferred.make<void>();
      const intercepted = HttpClient.make((request, _url, signal) => {
        if (request.headers.host !== "llm.gw.test" || request.method !== "POST")
          return client.execute(request);
        signal.addEventListener("abort", () => Deferred.doneUnsafe(aborted, Effect.void), {
          once: true,
        });
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("stream started"));
                },
              }),
            ),
          ),
        );
      });
      const settings = gatewayAddress().gateway;
      assert(Option.isSome(settings));
      const route = yield* gatewayModelRouteFor(
        WorkerName.make("coordinator-cancel"),
        RepositoryName.make("usine/coordinator"),
        settings.value,
      ).pipe(Effect.provideService(HttpClient.HttpClient, intercepted));
      const answer = yield* route.request("anthropic-messages", "{}", {}, controller.signal);
      assert(answer.body !== null);
      const reader = answer.body.getReader();
      yield* Effect.promise(() => reader.read());
      if (mode === "body cancellation") yield* Effect.promise(() => reader.cancel());
      else controller.abort();
      yield* Deferred.await(aborted);
    }).pipe(Effect.provide(transport.pipe(Layer.provideMerge(machine.layer))), Effect.scoped);
  },
);
