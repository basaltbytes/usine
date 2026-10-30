import { securityMiddleware } from "../../src/security.ts";
import { TestClock } from "effect/testing";
import { ActingMember, OperatorLogin } from "@usine/core/operator";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { assert, it } from "vitest";
import { authenticatedRoutes } from "../../src/auth/http.ts";
import { seedOperator } from "../../src/auth/authentication.ts";
import { GitHubSignIn } from "../../src/auth/github.ts";
import { AuthStore } from "../../src/auth/store.ts";
import { authFailure, Member, TokenName } from "../../src/auth/model.ts";
import { authFixture, alice, bob, localSecret } from "./fixture.ts";

const request = (
  app: { readonly handler: (request: Request) => Promise<Response> },
  path: string,
  method = "GET",
  body?: Readonly<Record<string, string>>,
  headers: Record<string, string> = {},
) => {
  const options: RequestInit = {
    method,
    headers: { "content-type": "application/json", ...headers },
  };
  if (body !== undefined) options.body = JSON.stringify(body);
  return app.handler(new Request(`https://usine.example${path}`, options));
};
const cookie = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
const linkToken = (url: string) =>
  new URLSearchParams(new URL(url).hash.slice(1)).get("link") ?? "";

it("requires authentication even from loopback, binds cookie writes to CSRF, and revokes sessions", async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const services = yield* authFixture();
      const { routes, guard } = authenticatedRoutes(services);
      const app = HttpRouter.toWebHandler(
        Layer.mergeAll(
          routes,
          HttpRouter.add(
            "POST",
            "/api/future-route",
            Effect.map(ActingMember, (member) =>
              HttpServerResponse.jsonUnsafe({ actor: Option.getOrNull(member) }),
            ),
          ).pipe(Layer.provide(guard.layer)),
        ),
        { disableLogger: true },
      );
      yield* Effect.addFinalizer(() => Effect.promise(() => app.dispose()));
      assert.equal(
        (yield* Effect.promise(() =>
          request(app, "/api/future-route", "POST", {}, { "x-forwarded-for": "127.0.0.1" }),
        )).status,
        401,
      );
      assert.equal(
        (yield* Effect.promise(() =>
          request(app, "/api/future-route", "POST", {}, { authorization: "Bearer invalid" }),
        )).status,
        401,
      );
      const token = linkToken(yield* services.authentication.link);
      const response = yield* Effect.promise(() =>
        request(app, "/api/auth/link/consume", "POST", { token }),
      );
      assert.equal(response.status, 200);
      const cookies = response.headers.getSetCookie();
      assert.isTrue(
        cookies.some(
          (value) =>
            value.startsWith("usine_session=") &&
            value.includes("HttpOnly") &&
            value.includes("Secure") &&
            value.includes("SameSite=Strict"),
        ),
      );
      const headers = { cookie: cookie(response) };
      assert.equal(
        (yield* Effect.promise(() => request(app, "/api/auth/link/consume", "POST", { token })))
          .status,
        401,
      );
      assert.equal(
        (yield* Effect.promise(() => request(app, "/api/future-route", "POST", {}, headers)))
          .status,
        403,
      );
      const session = yield* Effect.promise(() =>
        request(app, "/api/auth/session", "GET", undefined, headers),
      );
      const { csrf } = Schema.decodeUnknownSync(Schema.Struct({ csrf: Schema.String }))(
        yield* Effect.promise(() => session.json()),
      );
      const authorized = { ...headers, "x-usine-csrf": csrf };
      const action = yield* Effect.promise(() =>
        request(app, "/api/future-route", "POST", {}, authorized),
      );
      assert.deepEqual(yield* Effect.promise(() => action.json()), { actor: "alice" });
      assert.equal(
        (yield* Effect.promise(() => request(app, "/api/auth/sign-out", "POST", {}, authorized)))
          .status,
        200,
      );
      assert.equal(
        (yield* Effect.promise(() => request(app, "/api/tokens", "GET", undefined, headers)))
          .status,
        401,
      );
    }).pipe(Effect.scoped),
  ));

it("enrolls the first admin only after a setup link and a cookie-bound GitHub web flow", async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const services = yield* authFixture([]);
      const { routes } = authenticatedRoutes(services);
      const app = HttpRouter.toWebHandler(
        Layer.merge(routes, securityMiddleware(services.authentication)),
        { disableLogger: true },
      );
      yield* Effect.addFinalizer(() => Effect.promise(() => app.dispose()));
      const anonymous = yield* Effect.promise(() => request(app, "/api/auth/github"));
      const anonymousState =
        new URL(anonymous.headers.get("location") ?? "").searchParams.get("state") ?? "";
      const refused = yield* Effect.promise(() =>
        request(app, `/api/auth/callback?state=${anonymousState}&code=fake`, "GET", undefined, {
          cookie: cookie(anonymous),
        }),
      );
      assert.include(refused.headers.get("location") ?? "", "not%20a%20member");
      assert.deepEqual(yield* services.store.members, []);
      const token = linkToken(yield* services.authentication.link);
      const opened = yield* Effect.promise(() =>
        request(app, "/api/auth/link/consume", "POST", { token }),
      );
      const started = yield* Effect.promise(() =>
        request(app, "/api/auth/github", "GET", undefined, { cookie: cookie(opened) }),
      );
      const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
      const mismatch = yield* Effect.promise(() =>
        request(app, `/api/auth/callback?state=${state}&code=fake`),
      );
      assert.include(mismatch.headers.get("location") ?? "", "could%20not%20be%20verified");
      const completed = yield* Effect.promise(() =>
        request(app, `/api/auth/callback?state=${state}&code=fake`, "GET", undefined, {
          cookie: cookie(started),
        }),
      );
      assert.equal(completed.headers.get("location"), "/");
      assert.equal((yield* services.store.members)[0]?.login, alice.login);
      assert.equal(
        (yield* Effect.promise(() =>
          request(app, "/api/members", "GET", undefined, { cookie: cookie(completed) }),
        )).status,
        200,
      );
      assert.equal(
        (yield* Effect.promise(() =>
          request(app, "/api/members", "GET", undefined, { cookie: cookie(opened) }),
        )).status,
        401,
      );
      assert.include(services.seen, "https://api.github.com/user");
    }).pipe(Effect.scoped),
  ));

it("issues a device token once, refuses non-members, and expires one-time links", async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const services = yield* authFixture();
      const started = yield* services.authentication.startDevice(TokenName.make("Laptop"));
      yield* TestClock.adjust("2 seconds");
      const result = yield* services.authentication.pollDevice(Redacted.value(started.id));
      assert.isTrue(Option.isSome(result));
      if (Option.isNone(result)) return;
      const access = yield* services.authentication.authenticate(
        Redacted.value(result.value.secret),
      );
      assert.equal(Option.getOrNull(access.member)?.login, alice.login);
      assert.equal(
        (yield* services.authentication.pollDevice(Redacted.value(started.id)).pipe(Effect.flip))
          .status,
        401,
      );
      const outsiders = yield* authFixture([alice], bob);
      const outsider = yield* outsiders.authentication.startDevice(TokenName.make("Laptop"));
      yield* TestClock.adjust("2 seconds");
      assert.equal(
        (yield* outsiders.authentication.pollDevice(Redacted.value(outsider.id)).pipe(Effect.flip))
          .status,
        403,
      );
      const token = linkToken(yield* services.authentication.link);
      yield* TestClock.adjust("11 minutes");
      assert.equal(
        (yield* services.authentication.consumeLink(token).pipe(Effect.flip)).status,
        401,
      );
      const local = yield* services.authentication.authenticate(localSecret);
      assert.equal(Option.getOrNull(local.member)?.login, alice.login);
    }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
  ));

it("limits sign-in attempts globally and refuses cross-site link consumption", async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const services = yield* authFixture();
      const { routes } = authenticatedRoutes(services);
      const app = HttpRouter.toWebHandler(
        Layer.merge(routes, securityMiddleware(services.authentication)),
        { disableLogger: true },
      );
      yield* Effect.addFinalizer(() => Effect.promise(() => app.dispose()));
      const token = linkToken(yield* services.authentication.link);
      assert.equal(
        (yield* Effect.promise(() =>
          request(
            app,
            "/api/auth/link/consume",
            "POST",
            { token },
            { origin: "https://other.example" },
          ),
        )).status,
        403,
      );
      yield* services.authentication.consumeLink(token);
      for (let count = 1; count < 60; count++) yield* services.authentication.link;
      assert.equal((yield* services.authentication.link.pipe(Effect.flip)).status, 429);
      const started = yield* services.authentication.startDevice(TokenName.make("Phone"));
      assert.equal(
        (yield* services.authentication.pollDevice(Redacted.value(started.id)).pipe(Effect.flip))
          .status,
        429,
      );
    }).pipe(Effect.scoped),
  ));

it("restricts link issuance to the local credential and binds links to the original member", async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const services = yield* authFixture([alice, bob], bob);
      const { routes } = authenticatedRoutes(services);
      const app = HttpRouter.toWebHandler(
        Layer.merge(routes, securityMiddleware(services.authentication)),
        { disableLogger: true },
      );
      yield* Effect.addFinalizer(() => Effect.promise(() => app.dispose()));
      const web = yield* services.authentication.startWeb(false);
      const bobSession = yield* services.authentication.finishWeb(
        Redacted.value(web.state),
        "fake",
      );
      const headers = { authorization: `Bearer ${Redacted.value(bobSession.secret)}` };
      assert.equal(
        (yield* Effect.promise(() => request(app, "/api/auth/link", "POST", {}, headers))).status,
        403,
      );
      assert.equal(
        (yield* Effect.promise(() =>
          request(
            app,
            "/api/auth/link",
            "POST",
            {},
            {
              cookie: `usine_session=${Redacted.value(bobSession.secret)}`,
              "x-usine-csrf": bobSession.csrf,
            },
          ),
        )).status,
        403,
      );
      const response = yield* Effect.promise(() =>
        request(app, "/api/auth/link", "POST", {}, { authorization: `Bearer ${localSecret}` }),
      );
      assert.equal(response.status, 200);
      const { url } = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(
        yield* Effect.promise(() => response.json()),
      );
      yield* services.store.remove(alice.id);
      assert.equal(
        (yield* services.authentication.consumeLink(linkToken(url)).pipe(Effect.flip)).status,
        401,
      );
      const setup = yield* authFixture([]);
      const setupSession = yield* setup.authentication.consumeLink(
        linkToken(yield* setup.authentication.link),
      );
      const setupApp = HttpRouter.toWebHandler(authenticatedRoutes(setup).routes, {
        disableLogger: true,
      });
      yield* Effect.addFinalizer(() => Effect.promise(() => setupApp.dispose()));
      assert.equal(
        (yield* Effect.promise(() =>
          request(
            setupApp,
            "/api/auth/link",
            "POST",
            {},
            { authorization: `Bearer ${Redacted.value(setupSession.secret)}` },
          ),
        )).status,
        403,
      );
    }).pipe(Effect.scoped),
  ));

it("keeps valid sign-ins available after invalid challenges exhaust their limits", async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { authentication: auth } = yield* authFixture();
      const link = linkToken(yield* auth.link);
      const web = yield* auth.startWeb(false);
      const device = yield* auth.startDevice(TokenName.make("Phone"));
      for (let count = 0; count < 61; count++) {
        const status = count < 60 ? 401 : 429;
        assert.equal((yield* auth.consumeLink("invalid").pipe(Effect.flip)).status, status);
        assert.equal((yield* auth.finishWeb("invalid", "fake").pipe(Effect.flip)).status, status);
        assert.equal((yield* auth.pollDevice("invalid").pipe(Effect.flip)).status, status);
      }
      yield* auth.consumeLink(link);
      yield* auth.finishWeb(Redacted.value(web.state), "fake");
      yield* TestClock.adjust("2 seconds");
      assert.isTrue(Option.isSome(yield* auth.pollDevice(Redacted.value(device.id))));
    }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
  ));

it("persists a GitHub login rename through web and device sign-in", async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const renamed = new Member({ ...alice, login: OperatorLogin.make("alice-renamed") });
      for (const flow of ["web", "device"] as const) {
        const { authentication: auth, store } = yield* authFixture([alice], renamed);
        const signIn =
          flow === "web"
            ? Effect.gen(function* () {
                const started = yield* auth.startWeb(false);
                return yield* auth.finishWeb(Redacted.value(started.state), "fake");
              })
            : Effect.gen(function* () {
                const started = yield* auth.startDevice(TokenName.make("Phone"));
                yield* TestClock.adjust("2 seconds");
                const issued = yield* auth.pollDevice(Redacted.value(started.id));
                assert.isTrue(Option.isSome(issued));
                if (Option.isNone(issued)) return yield* authFailure("Expected a device token");
                return issued.value;
              });
        const session = yield* signIn;
        const access = yield* auth.authenticate(Redacted.value(session.secret));
        assert.equal(Option.getOrNull(access.member)?.login, renamed.login);
        assert.deepEqual(yield* store.members, [renamed]);
        yield* store.add(new Member({ ...bob, login: alice.login }), false);
      }
    }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
  ));

it("defers operator enrollment when GitHub is unavailable and retries on the next start", async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const services = yield* authFixture([]);
      const seed = seedOperator(Option.some(alice.login)).pipe(
        Effect.provideService(AuthStore, services.store),
      );
      yield* seed.pipe(
        Effect.provideService(GitHubSignIn, {
          ...services.github,
          lookup: () => Effect.fail(authFailure("GitHub is unavailable", 502)),
        }),
      );
      assert.deepEqual(yield* services.store.members, []);
      yield* seed.pipe(Effect.provideService(GitHubSignIn, services.github));
      assert.equal((yield* services.store.members)[0]?.id, alice.id);
    }).pipe(Effect.scoped),
  ));
