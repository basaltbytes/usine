import { TestClock } from "effect/testing";
import { ActingMember } from "@usine/core/operator";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { assert, it } from "vitest";
import { authenticatedRoutes } from "../../src/auth/http.ts";
import { TokenName } from "../../src/auth/model.ts";
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
          guard,
          HttpRouter.add(
            "POST",
            "/api/future-route",
            Effect.map(ActingMember, (member) =>
              HttpServerResponse.jsonUnsafe({ actor: Option.getOrNull(member) }),
            ),
          ),
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
      const { routes, guard } = authenticatedRoutes(services);
      const app = HttpRouter.toWebHandler(Layer.mergeAll(routes, guard), { disableLogger: true });
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
      const { routes, guard } = authenticatedRoutes(services);
      const app = HttpRouter.toWebHandler(Layer.mergeAll(routes, guard), { disableLogger: true });
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
