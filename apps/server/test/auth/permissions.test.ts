import { RoleBinding, ProjectScope, InstanceScope } from "@usine/core/access";
import { ProjectId } from "@usine/core/project";
import { Effect, Layer, Redacted } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { assert, it } from "vitest";
import { AuthApi, authPermissions } from "../../src/auth/api.ts";
import { authenticatedRoutes } from "../../src/auth/http.ts";
import { SetupApi, setupPermissions } from "../../src/setup/api.ts";
import { alice, authFixture } from "./fixture.ts";

it("applies the credential and role matrix to every auth and setup endpoint", async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (const role of ["viewer", "operator", "maintainer", "admin"] as const) {
        const grants = new RoleBinding({
          name: role,
          member: alice.id,
          role,
          scope:
            role === "admin"
              ? new InstanceScope()
              : new ProjectScope({ project: ProjectId.make("alpha") }),
        }).permissions;
        const services = yield* authFixture([alice], alice, () => grants);
        const link = new URL(yield* services.authentication.link);
        const issued = yield* services.authentication.consumeLink(
          new URLSearchParams(link.hash.slice(1)).get("link") ?? "",
        );
        const endpoints = [
          ...Object.values(AuthApi.endpoints).map((endpoint) => ({
            endpoint,
            requirement: authPermissions[endpoint.identifier],
          })),
          ...Object.values(SetupApi.endpoints).map((endpoint) => ({
            endpoint,
            requirement: setupPermissions[endpoint.identifier],
          })),
        ];
        const protectedEndpoints = endpoints.filter(({ requirement }) => requirement !== "public");
        const auth = authenticatedRoutes(services);
        const app = HttpRouter.toWebHandler(
          HttpRouter.addAll(
            protectedEndpoints.map(({ endpoint }) =>
              HttpRouter.route(endpoint.method, endpoint.path, HttpServerResponse.empty()),
            ),
          ).pipe(Layer.provide(auth.guard.layer)),
          { disableLogger: true },
        );
        yield* Effect.addFinalizer(() => Effect.promise(() => app.dispose()));
        for (const { endpoint, requirement } of protectedEndpoints) {
          const allowed =
            requirement === "local"
              ? false
              : requirement === "admin" || requirement === "setup"
                ? role === "admin"
                : true;
          const response = yield* Effect.promise(() =>
            app.handler(
              new Request(`https://usine.example${endpoint.path.replace(":id", "2")}`, {
                method: endpoint.method,
                headers: { authorization: `Bearer ${Redacted.value(issued.secret)}` },
              }),
            ),
          );
          assert.equal(
            response.status,
            allowed ? 204 : 403,
            `${role}: ${endpoint.method} ${endpoint.path}`,
          );
        }
      }
    }).pipe(Effect.scoped),
  ));
