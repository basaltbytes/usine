import { administratorPermissions } from "@usine/core/access";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { HttpRouter } from "effect/http";
import { ProviderLogins } from "../src/providers/control.ts";
import { providerRoutes } from "../src/providers/http.ts";
import { authenticatedRoutes } from "../src/auth/http.ts";
import { authFixture, alice, localSecret } from "./auth/fixture.ts";

it.live("requires admin access and CSRF for provider credentials and allows setup sessions", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let granted = false;
      const services = yield* authFixture([alice], alice, () =>
        granted ? administratorPermissions : [],
      );
      const { guard } = authenticatedRoutes(services);
      const app = HttpRouter.toWebHandler(
        providerRoutes.pipe(
          Layer.provide(guard.layer),
          HttpRouter.provideRequest(
            Layer.succeed(ProviderLogins, {
              status: Effect.succeed({ targets: [], logins: [] }),
              begin: () => Effect.die("unused begin"),
              submit: () => Effect.void,
              cancel: () => Effect.void,
              apiKey: () => Effect.void,
              disconnect: () => Effect.void,
            }),
          ),
        ),
        { disableLogger: true },
      );
      yield* Effect.addFinalizer(() => Effect.promise(() => app.dispose()));
      const request = (headers: Record<string, string>, path = "/api/providers", method = "GET") =>
        Effect.promise(() => {
          const options: RequestInit = { method, headers };
          if (method !== "GET")
            options.body = '{"target":"local","provider":"claude","key":"private-key"}';
          return app.handler(new Request(`https://usine.example${path}`, options));
        });
      assert.equal((yield* request({})).status, 401);
      const web = yield* services.authentication.startWeb(false);
      const member = yield* services.authentication.finishWeb(Redacted.value(web.state), "fake");
      assert.equal(
        (yield* request({ authorization: `Bearer ${Redacted.value(member.secret)}` })).status,
        403,
      );
      assert.equal((yield* request({ authorization: `Bearer ${localSecret}` })).status, 200);
      granted = true;
      const link = yield* services.authentication.link;
      const session = yield* services.authentication.consumeLink(
        new URLSearchParams(new URL(link).hash.slice(1)).get("link") ?? "",
      );
      const cookie = `usine_session=${Redacted.value(session.secret)}`;
      assert.equal((yield* request({ cookie }, "/api/providers/key", "PUT")).status, 403);
      assert.equal(
        (yield* request(
          { cookie, "x-usine-csrf": session.csrf, "content-type": "application/json" },
          "/api/providers/key",
          "PUT",
        )).status,
        200,
      );
      const setup = yield* authFixture([]);
      const setupLink = yield* setup.authentication.link;
      const bootstrap = yield* setup.authentication.consumeLink(
        new URLSearchParams(new URL(setupLink).hash.slice(1)).get("link") ?? "",
      );
      const setupApp = HttpRouter.toWebHandler(
        providerRoutes.pipe(
          Layer.provide(authenticatedRoutes(setup).guard.layer),
          HttpRouter.provideRequest(
            Layer.succeed(ProviderLogins, {
              status: Effect.succeed({ targets: [], logins: [] }),
              begin: () => Effect.die("unused"),
              submit: () => Effect.void,
              cancel: () => Effect.void,
              apiKey: () => Effect.void,
              disconnect: () => Effect.void,
            }),
          ),
        ),
        { disableLogger: true },
      );
      yield* Effect.addFinalizer(() => Effect.promise(() => setupApp.dispose()));
      const response = yield* Effect.promise(() =>
        setupApp.handler(
          new Request("https://usine.example/api/providers", {
            headers: { authorization: `Bearer ${Redacted.value(bootstrap.secret)}` },
          }),
        ),
      );
      assert.equal(response.status, 200);
    }),
  ),
);
