import { NodeHttpServer } from "@effect/platform-node";
import { TestClock } from "effect/testing";
import { createHmac } from "node:crypto";
import { UsineConfig } from "@usine/config/factory";
import { LoadedInstance } from "@usine/config/instance";
import { RepositoryName } from "@usine/core/repository";
import { GitHubApiError } from "@usine/github/github-app";
import { WebhookHealth } from "@usine/orchestrator/webhooks";
import {
  ConfigProvider,
  Effect,
  Fiber,
  Layer,
  Option,
  Ref,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";
import { HttpClient, HttpClientRequest, HttpRouter, HttpServerResponse } from "effect/http";
import { assert, it } from "vitest";
import { authenticatedRoutes } from "../src/auth/http.ts";
import { webhookEndpoint } from "../src/webhooks.ts";
import { authFixture } from "./auth/fixture.ts";

const secret = "webhook-test-secret";
const repository = RepositoryName.make("test/repo");
const instance = (mode: "off" | "deliveries" | "endpoint") =>
  new LoadedInstance({
    config: Schema.decodeUnknownSync(UsineConfig)({
      version: 1,
      repos: [{ name: repository }],
      webhooks:
        mode === "endpoint"
          ? { mode, public_url: "https://usine.example/webhooks/github" }
          : { mode },
    }),
    agents: [],
    loops: [],
    invalidAgents: [],
    quarantinedLoops: [],
    warnings: [],
  });
const signature = (body: string) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const send = (
  handler: (request: Request) => Promise<Response>,
  body: string,
  sig = signature(body),
  event = "issues",
) =>
  Effect.promise(() =>
    handler(
      new Request("https://usine.example/webhooks/github", {
        method: "POST",
        body,
        headers: { "x-hub-signature-256": sig, "x-github-event": event },
      }),
    ),
  );
const configured = ConfigProvider.fromUnknown({ USINE_GITHUB_WEBHOOK_SECRET: secret });

const endpoint = (
  instances: { readonly get: Effect.Effect<LoadedInstance> },
  ...args: [
    Parameters<typeof webhookEndpoint>[1],
    Parameters<typeof webhookEndpoint>[2],
    Parameters<typeof webhookEndpoint>[3],
  ]
) =>
  webhookEndpoint(
    { ...instances, changes: Stream.concat(Stream.fromEffect(instances.get), Stream.never) },
    ...args,
  );

it("verifies the raw body outside operator authentication and hints only current registered repositories", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const current = yield* Ref.make(instance("endpoint"));
      const hints: RepositoryName[] = [];
      const urls: string[] = [];
      const health = yield* WebhookHealth;
      const routes = yield* endpoint(
        { get: Ref.get(current) },
        {
          hint: (name) =>
            Effect.sync(() => {
              hints.push(name);
            }),
        },
        health,
        {
          configureWebhook: (url) =>
            Effect.sync(() => {
              urls.push(url.href);
            }),
        },
      );
      assert.deepEqual(urls, ["https://usine.example/webhooks/github"]);
      const auth = authenticatedRoutes(yield* authFixture());
      const web = HttpRouter.toWebHandler(
        Layer.merge(
          routes,
          HttpRouter.add("POST", "/api/private", HttpServerResponse.empty()).pipe(
            Layer.provide(auth.guard.layer),
          ),
        ),
        { disableLogger: true },
      );
      yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()));
      const privateResponse = yield* Effect.promise(() =>
        web.handler(new Request("https://usine.example/api/private", { method: "POST" })),
      );
      assert.equal(privateResponse.status, 401);
      const body = '{\n "repository": { "full_name": "Test/Repo" }, "title": "été 🛶"\n}';
      for (const sig of [
        "",
        "sha1=bad",
        "sha256=00",
        `sha256=${"00".repeat(32)}`,
        signature(`${body} `),
      ]) {
        assert.equal((yield* send(web.handler, body, sig)).status, 401);
      }
      assert.equal((yield* send(web.handler, "{bad json", "invalid")).status, 401);
      for (const bad of ["{bad json", "null", '{"repository":{"full_name":42}}']) {
        assert.equal((yield* send(web.handler, bad)).status, 400);
      }
      assert.equal((yield* send(web.handler, body, signature(body), "")).status, 400);
      assert.deepEqual(hints, []);
      yield* TestClock.adjust("10 minutes");
      assert.isTrue(yield* health.silent);
      assert.equal((yield* send(web.handler, body)).status, 204);
      assert.equal((yield* send(web.handler, body)).status, 204);
      assert.deepEqual(hints, [repository, repository]);
      assert.isFalse(yield* health.silent);
      for (const [payload, event] of [
        ["{}", "ping"],
        [body, "ping"],
        ["{}", "installation"],
        ['{"repository":{"full_name":"other/repo"}}', "push"],
      ] as const) {
        assert.equal((yield* send(web.handler, payload, signature(payload), event)).status, 204);
      }
      assert.equal(hints.length, 2);
      yield* Ref.update(
        current,
        (loaded) =>
          new LoadedInstance({
            ...loaded,
            config: new UsineConfig({ ...loaded.config, repos: [] }),
          }),
      );
      assert.equal((yield* send(web.handler, body)).status, 204);
      assert.equal(hints.length, 2);
    }).pipe(
      Effect.provide(WebhookHealth.layer),
      Effect.provide(TestClock.layer()),
      Effect.provideService(ConfigProvider.ConfigProvider, configured),
      Effect.scoped,
    ),
  ));

it("requires a nonempty secret only in endpoint mode and keeps the endpoint available after a hook API failure", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const health = yield* WebhookHealth;
      const polling = { hint: () => Effect.void };
      for (const mode of ["off", "deliveries"] as const) {
        const routes = yield* endpoint({ get: Effect.succeed(instance(mode)) }, polling, health, {
          configureWebhook: () => Effect.die("Disabled endpoint must not configure the App"),
        }).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
        );
        const web = HttpRouter.toWebHandler(routes, { disableLogger: true });
        yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()));
        assert.equal((yield* send(web.handler, "{}")).status, 404);
      }
      const app = {
        configureWebhook: () =>
          Effect.fail(
            new GitHubApiError({
              operation: "configure-webhook",
              status: Option.some(403),
              message: "Forbidden",
            }),
          ),
      };
      for (const values of [{}, { USINE_GITHUB_WEBHOOK_SECRET: "" }]) {
        const failure = yield* endpoint(
          { get: Effect.succeed(instance("endpoint")) },
          polling,
          health,
          app,
        ).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(values)),
          Effect.flip,
        );
        assert.equal(failure._tag, "WebhookConfigurationError");
      }
      const routes = yield* endpoint(
        { get: Effect.succeed(instance("endpoint")) },
        polling,
        health,
        app,
      );
      const web = HttpRouter.toWebHandler(routes, { disableLogger: true });
      yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()));
      assert.equal((yield* send(web.handler, "{}", signature("{}"), "ping")).status, 204);
    }).pipe(
      Effect.provide(WebhookHealth.layer),
      Effect.provide(TestClock.layer()),
      Effect.provideService(ConfigProvider.ConfigProvider, configured),
      Effect.scoped,
    ),
  ));

it("bounds startup hook configuration and request bodies on the Node HTTP server", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const health = yield* WebhookHealth;
      const starting = yield* endpoint(
        { get: Effect.succeed(instance("endpoint")) },
        { hint: () => Effect.void },
        health,
        { configureWebhook: () => Effect.never },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("30 seconds");
      const routes = yield* Fiber.join(starting);
      const server = HttpRouter.serve(routes).pipe(Layer.provideMerge(NodeHttpServer.layerTest));
      yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const oversized = JSON.stringify({ unused: "x".repeat(25 * 1024 * 1024) });
        for (const [body, status] of [
          [oversized, 400],
          ["{}", 204],
        ] as const) {
          const response = yield* client.execute(
            HttpClientRequest.post("/webhooks/github").pipe(
              HttpClientRequest.bodyText(body),
              HttpClientRequest.setHeaders({
                "x-hub-signature-256": signature(body),
                "x-github-event": "ping",
              }),
            ),
          );
          assert.equal(response.status, status);
        }
      }).pipe(Effect.provide(server));
    }).pipe(
      Effect.provide(WebhookHealth.layer),
      Effect.provide(TestClock.layer()),
      Effect.provideService(ConfigProvider.ConfigProvider, configured),
      Effect.scoped,
    ),
  ));

it("switches a running endpoint between modes and public URLs without rebuilding the server", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const current = yield* SubscriptionRef.make(instance("off"));
      const hints: RepositoryName[] = [];
      const urls: string[] = [];
      const health = yield* WebhookHealth;
      const routes = yield* webhookEndpoint(
        { get: SubscriptionRef.get(current), changes: SubscriptionRef.changes(current) },
        {
          hint: (name) =>
            Effect.sync(() => {
              hints.push(name);
            }),
        },
        health,
        {
          configureWebhook: (url) =>
            Effect.sync(() => {
              urls.push(url.href);
            }),
        },
      );
      const web = HttpRouter.toWebHandler(routes, { disableLogger: true });
      yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()));
      const body = JSON.stringify({ repository: { full_name: repository } });
      assert.equal((yield* send(web.handler, body)).status, 404);
      yield* TestClock.adjust("1 day");
      yield* SubscriptionRef.set(current, instance("endpoint"));
      yield* TestClock.adjust("1 millis");
      assert.isFalse(yield* health.silent);
      assert.equal((yield* send(web.handler, body)).status, 204);
      assert.deepEqual(hints, [repository]);
      yield* SubscriptionRef.update(
        current,
        (loaded) =>
          new LoadedInstance({
            ...loaded,
            config: new UsineConfig({
              ...loaded.config,
              webhooks: {
                mode: "endpoint",
                publicUrl: new URL("https://new.example/webhooks/github"),
              },
            }),
          }),
      );
      yield* TestClock.adjust("1 millis");
      assert.deepEqual(urls, [
        "https://usine.example/webhooks/github",
        "https://new.example/webhooks/github",
      ]);
      for (const mode of ["deliveries", "off"] as const) {
        yield* SubscriptionRef.set(current, instance(mode));
        yield* TestClock.adjust("1 millis");
        assert.equal((yield* send(web.handler, body)).status, 404);
      }
      assert.deepEqual(hints, [repository]);
    }).pipe(
      Effect.provide(WebhookHealth.layer),
      Effect.provide(TestClock.layer()),
      Effect.provideService(ConfigProvider.ConfigProvider, configured),
      Effect.scoped,
    ),
  ));
