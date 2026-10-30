import { generateKeyPairSync } from "node:crypto";
import { NodeServices, NodeHttpServer } from "@effect/platform-node";
import { InstanceDirectory } from "@usine/core/instance";
import { REQUIRED_REPOSITORY_PERMISSIONS } from "@usine/github/github-app";
import { GITHUB_APP_SECRETS_PATH, loadLocalSecrets } from "@usine/github/local-secrets";
import {
  ConfigProvider,
  Context,
  Deferred,
  Fiber,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter } from "effect/http";
import { assert, it } from "vitest";
import { GitHubSignIn, githubSignInLayer } from "../../src/auth/github.ts";
import { authenticatedRoutes } from "../../src/auth/http.ts";
import { Setup } from "../../src/setup/control.ts";
import { securityMiddleware } from "../../src/security.ts";
import { setupRoutes } from "../../src/setup/http.ts";
import { alice, authFixture, localSecret } from "../auth/fixture.ts";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString();
const conversion = {
  id: 123,
  pem,
  client_id: "Iv1.created",
  client_secret: "client-secret",
  webhook_secret: "hook-secret",
};
const emptyEnvironment = ConfigProvider.layer(ConfigProvider.fromUnknown({}));

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = InstanceDirectory.make(
    yield* fs.makeTempDirectoryScoped({ prefix: "usine-setup-" }),
  );
  const auth = yield* authFixture([]);
  let installed = false;
  let registered = false;
  let exchangeStatus = 201;
  const requests: string[] = [];
  const client = HttpClient.make((request) => {
    requests.push(request.url);
    const payload = request.url.includes("/conversions")
      ? conversion
      : request.url.endsWith("/app")
        ? { slug: "created-app" }
        : request.url.includes("/access_tokens")
          ? {
              token: "installation-token",
              expires_at: new Date(Date.now() + 3600_000).toISOString(),
            }
          : request.url.includes("/app/installations")
            ? installed
              ? [
                  {
                    id: 77,
                    app_slug: "created-app",
                    account: { login: "alice" },
                    permissions: REQUIRED_REPOSITORY_PERMISSIONS,
                    suspended_at: null,
                  },
                ]
              : []
            : request.url.includes("/access_token")
              ? { access_token: "user-token" }
              : alice;
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json(payload, {
          status: request.url.includes("/conversions") ? exchangeStatus : 200,
        }),
      ),
    );
  });
  const source = loadLocalSecrets(directory).pipe(Effect.provide(NodeServices.layer));
  const githubContext = yield* Layer.build(
    githubSignInLayer(source).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
  );
  const github = Context.get(githubContext, GitHubSignIn);
  const setupContext = yield* Layer.build(
    Setup.layer(
      directory,
      Effect.sync(() => registered),
      { ...auth, github },
      "setup",
    ).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
  );
  const setup = Context.get(setupContext, Setup);
  const resume = Layer.build(
    Setup.layer(
      directory,
      Effect.sync(() => registered),
      { ...auth, github },
      "setup",
    ).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
  ).pipe(Effect.map((context) => Context.get(context, Setup)));
  const routes = setupRoutes(setup, auth.authentication.origin);
  const secured = authenticatedRoutes(auth);
  const transportRoutes = Layer.mergeAll(
    securityMiddleware(auth.authentication),
    routes.callback,
    routes.protected.pipe(Layer.provide(secured.guard.layer)),
  );
  const app = HttpRouter.toWebHandler(transportRoutes, { disableLogger: true });
  yield* Effect.addFinalizer(() => Effect.promise(() => app.dispose()));
  const request = (
    path: string,
    body?: Schema.Json,
    headers: Record<string, string> = { authorization: `Bearer ${localSecret}` },
  ) =>
    Effect.promise(() => {
      const options: RequestInit = {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", ...headers },
      };
      if (body !== undefined) options.body = JSON.stringify(body);
      return app.handler(new Request(`https://usine.example${path}`, options));
    });
  const begin = Effect.gen(function* () {
    const response = yield* request(
      "/api/setup/manifest",
      { name: "usine test" },
      {
        authorization: `Bearer ${localSecret}`,
        origin: "https://usine.example",
      },
    );
    assert.equal(response.status, 200);
    const result = Schema.decodeUnknownSync(
      Schema.Struct({ action: Schema.String, manifest: Schema.String }),
    )(yield* Effect.promise(() => response.json()));
    const state = new URL(result.action).searchParams.get("state");
    assert.ok(state);
    return { ...result, state, cookie: `usine_app_state=${state}` };
  });
  return {
    fs,
    directory,
    auth,
    github,
    setup,
    request,
    begin,
    requests,
    resume,
    transportRoutes,
    install: () => {
      installed = true;
    },
    register: () => {
      registered = true;
    },
    failExchange: () => {
      exchangeStatus = 503;
    },
  };
});
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.provide(emptyEnvironment));

it("resumes all setup states, exchanges the redirect once, and saves complete owner-only secrets", () =>
  Effect.runPromise(
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        assert.deepEqual(yield* f.setup.status, { _tag: "NoApp" });
        assert.equal((yield* f.request("/api/setup/activate", {})).status, 409);
        assert.equal(yield* f.github.available, false);
        const begun = yield* f.begin;
        const manifest = JSON.parse(begun.manifest);
        assert.deepEqual(manifest.default_permissions, REQUIRED_REPOSITORY_PERMISSIONS);
        assert.deepEqual(manifest.callback_urls, ["https://usine.example/api/auth/callback"]);
        assert.equal(manifest.hook_attributes.url, "https://usine.example/webhooks/github");
        assert.equal((yield* (yield* f.resume).status)._tag, "MissingKey");
        const rejected = yield* f.request(
          `/api/setup/callback?state=${begun.state}&code=code`,
          undefined,
          {},
        );
        assert.match(rejected.headers.get("location") ?? "", /could%20not%20be%20verified/);
        assert.equal(f.requests.length, 0);
        const callback = `/api/setup/callback?state=${begun.state}&code=code`;
        const response = yield* f.request(callback, undefined, { cookie: begun.cookie });
        assert.equal(response.headers.get("location"), "/setup");
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");
        assert.include(response.headers.get("content-security-policy") ?? "", "script-src 'self'");
        assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/);
        const target = `${f.directory}/${GITHUB_APP_SECRETS_PATH}`;
        assert.equal((yield* f.fs.stat(target)).mode & 0o777, 0o600);
        assert.deepEqual(JSON.parse(yield* f.fs.readFileString(target)), {
          app_id: 123,
          private_key: pem,
          client_id: conversion.client_id,
          client_secret: conversion.client_secret,
          webhook_secret: conversion.webhook_secret,
        });
        assert.equal(yield* f.github.available, true);
        assert.match(
          yield* f.github.authorizeUrl("state", "https://usine.example/api/auth/callback"),
          /client_id=Iv1.created/,
        );
        assert.equal(
          (yield* f.github.web("user-code", "https://usine.example/api/auth/callback")).login,
          alice.login,
        );
        const replay = yield* f.request(callback, undefined, { cookie: begun.cookie });
        assert.match(replay.headers.get("location") ?? "", /already%20completed/);
        assert.equal(f.requests.filter((url) => url.includes("/conversions")).length, 1);
        const installation = yield* (yield* f.resume).status;
        assert.equal(installation._tag, "NeedsInstallation");
        if (installation._tag === "NeedsInstallation")
          assert.equal(installation.url, "https://github.com/apps/created-app/installations/new");
        f.install();
        assert.deepEqual(yield* f.setup.status, {
          _tag: "Repositories",
          signIn: true,
          github: true,
        });
        yield* f.auth.store.add(alice, true);
        assert.deepEqual(yield* f.setup.status, {
          _tag: "Repositories",
          signIn: false,
          github: true,
        });
        f.register();
        assert.deepEqual(yield* f.setup.status, { _tag: "Ready" });
        assert.equal((yield* f.request("/api/setup/manifest", { name: "overwrite" })).status, 409);
      }),
    ),
  ));

it("keeps failed exchange recoverable, rejects unsafe requests, and restores legacy credentials", () =>
  Effect.runPromise(
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        assert.equal((yield* f.request("/api/setup/manifest", { name: "usine" }, {})).status, 401);
        const crossSite = yield* f.request(
          "/api/setup/manifest",
          { name: "usine" },
          {
            authorization: `Bearer ${localSecret}`,
            origin: "https://evil.example",
          },
        );
        assert.equal(crossSite.status, 403);
        assert.isNull(crossSite.headers.get("access-control-allow-origin"));
        assert.deepEqual(yield* f.setup.status, { _tag: "NoApp" });
        const session = yield* f.auth.authentication.consumeLink(
          new URLSearchParams(new URL(yield* f.auth.authentication.link).hash.slice(1)).get(
            "link",
          ) ?? "",
        );
        assert.equal(
          (yield* f.request(
            "/api/setup/manifest",
            { name: "usine" },
            { cookie: `usine_session=${Redacted.value(session.secret)}` },
          )).status,
          403,
        );
        const begun = yield* f.begin;
        f.failExchange();
        const response = yield* f.request(
          `/api/setup/callback?state=${begun.state}&code=unavailable`,
          undefined,
          { cookie: begun.cookie },
        );
        assert.match(response.headers.get("location") ?? "", /GitHub%20could%20not/);
        assert.equal(yield* f.fs.exists(`${f.directory}/${GITHUB_APP_SECRETS_PATH}`), false);
        assert.equal((yield* (yield* f.resume).status)._tag, "MissingKey");
        const restored = yield* f.request("/api/setup/restore", {
          credentials: JSON.stringify({ app_id: 123, private_key: pem }),
        });
        assert.equal(restored.status, 200);
        const saved = yield* loadLocalSecrets(f.directory);
        assert.ok(Option.isSome(saved));
        if (Option.isSome(saved)) assert.equal(Option.isNone(saved.value.clientId), true);
        assert.equal((yield* f.setup.status)._tag, "NeedsInstallation");
      }),
    ),
  ));

it("drains the activation response before closing setup HTTP and preserves its authentication session", () =>
  Effect.runPromise(
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        const token =
          new URLSearchParams(new URL(yield* f.auth.authentication.link).hash.slice(1)).get(
            "link",
          ) ?? "";
        const session = yield* f.auth.authentication.consumeLink(token);
        const ready = yield* Deferred.make<HttpClient.HttpClient>();
        yield* f.setup.restore(JSON.stringify({ app_id: 123, private_key: pem }));
        const server = HttpRouter.serve(f.transportRoutes).pipe(
          Layer.provideMerge(NodeHttpServer.layerTest),
        );
        const serving = Effect.gen(function* () {
          yield* Deferred.succeed(ready, yield* HttpClient.HttpClient);
          return yield* Effect.never;
        }).pipe(Effect.provide(server), Effect.raceFirst(f.setup.changed));
        const running = yield* serving.pipe(Effect.forkScoped);
        const client = yield* Deferred.await(ready);
        const response = yield* client.execute(
          HttpClientRequest.post("/api/setup/activate").pipe(
            HttpClientRequest.bearerToken(session.secret),
          ),
        );
        assert.equal(response.status, 200);
        assert.deepEqual(yield* response.json, { ok: true });
        yield* Fiber.join(running);
        const access = yield* f.auth.authentication.authenticate(Redacted.value(session.secret));
        assert.equal(access.credential, "bootstrap");
        assert.equal((yield* (yield* f.resume).status)._tag, "NeedsInstallation");
      }),
    ),
  ));
