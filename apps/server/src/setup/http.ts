import { Effect, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { authFailure, type AuthError } from "../auth/model.ts";
import type { Setup } from "./control.ts";
import { ManifestRequest } from "./model.ts";

const COOKIE = "usine_app_state";
const json = HttpServerResponse.jsonUnsafe;
const body = <A, I>(schema: Schema.Codec<A, I>) =>
  HttpServerRequest.schemaBodyJson(schema, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => authFailure("Invalid setup request.", 400)),
  );

export const setupRoutes = (setup: Setup["Service"], origin: string) => ({
  protected: HttpRouter.addAll([
    HttpRouter.route("GET", "/api/setup/runtime", json({ ready: setup.running })),
    HttpRouter.route("POST", "/api/setup/activate", Effect.as(setup.activate, json({ ok: true }))),
    HttpRouter.route("GET", "/api/setup", Effect.map(setup.status, json)),
    HttpRouter.route(
      "POST",
      "/api/setup/manifest",
      Effect.gen(function* () {
        const result = yield* setup.begin(yield* body(ManifestRequest));
        return json({ action: result.action, manifest: result.manifest }).pipe(
          HttpServerResponse.setCookieUnsafe(COOKIE, result.state, {
            httpOnly: true,
            secure: new URL(origin).protocol === "https:",
            sameSite: "lax",
            path: "/api/setup",
            maxAge: "10 minutes",
          }),
        );
      }),
    ),
    HttpRouter.route(
      "POST",
      "/api/setup/restore",
      Effect.gen(function* () {
        const { credentials } = yield* body(Schema.Struct({ credentials: Schema.NonEmptyString }));
        yield* setup.restore(credentials);
        return json({ ok: true });
      }),
    ),
  ] satisfies ReadonlyArray<HttpRouter.Route<AuthError>>),
  callback: HttpRouter.add(
    "GET",
    "/api/setup/callback",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const params = new URL(request.url, origin).searchParams;
      const state = params.get("state");
      const code = params.get("code");
      if (state === null || code === null || request.cookies[COOKIE] !== state)
        return yield* authFailure(
          "App creation could not be verified. Open setup and try again.",
          400,
        );
      yield* setup.exchange(state, code);
      return HttpServerResponse.redirect("/setup");
    }).pipe(
      Effect.catchTag("AuthError", (error) =>
        Effect.logWarning("GitHub App setup callback failed", { status: error.status }).pipe(
          Effect.as(
            HttpServerResponse.redirect(`/setup?error=${encodeURIComponent(error.message)}`),
          ),
        ),
      ),
      Effect.map((response) =>
        response.pipe(
          HttpServerResponse.expireCookieUnsafe(COOKIE, { path: "/api/setup" }),
          HttpServerResponse.setHeaders({
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            "x-frame-options": "DENY",
          }),
        ),
      ),
    ),
  ),
});
