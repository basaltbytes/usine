import { ActingMember, OperatorLogin } from "@usine/core/operator";
import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Authentication, type Access, type IssuedToken } from "./authentication.ts";
import { GitHubSignIn } from "./github.ts";
import { AuthError, authFailure, GitHubUserId, Member, TokenId, TokenName } from "./model.ts";
import { AuthStore } from "./store.ts";

export interface AuthServices {
  readonly authentication: Authentication["Service"];
  readonly store: AuthStore["Service"];
  readonly github: GitHubSignIn["Service"];
}
const RequestAccess = Context.Reference<Option.Option<Access>>("@usine/server/RequestAccess", {
  defaultValue: Option.none,
});
const accessEffect = Effect.flatMap(RequestAccess, (access) =>
  Option.match(access, {
    onNone: () => Effect.fail(authFailure("Sign in to continue.")),
    onSome: Effect.succeed,
  }),
);
const COOKIE = "usine_session";
const STATE_COOKIE = "usine_sign_in_state";
const PUBLIC = new Set([
  "/api/health",
  "/api/auth/github",
  "/api/auth/callback",
  "/api/auth/device",
  "/api/auth/device/poll",
  "/api/auth/link/consume",
  "/api/auth/info",
]);
const json = <A>(body: A, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });
const secretOf = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.authorization?.startsWith("Bearer ")
    ? request.headers.authorization.slice(7)
    : (request.cookies[COOKIE] ?? "");
const body = <A, I>(schema: Schema.Codec<A, I>) =>
  HttpServerRequest.schemaBodyJson(schema, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => authFailure("Invalid request.", 400)),
  );
const sensitive = HttpServerResponse.setHeaders({
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

export const authenticatedRoutes = (services: AuthServices) => {
  const { authentication: auth, store, github } = services;
  const secure =
    !["localhost", "127.0.0.1", "[::1]"].includes(new URL(auth.origin).hostname) ||
    new URL(auth.origin).protocol === "https:";
  const session = (issued: IssuedToken, response = json({ ok: true })) =>
    response.pipe(
      HttpServerResponse.setCookieUnsafe("usine_csrf", issued.csrf, {
        secure,
        sameSite: "strict",
        path: "/",
        maxAge: "30 days",
      }),
      HttpServerResponse.setCookieUnsafe(COOKIE, Redacted.value(issued.secret), {
        httpOnly: true,
        secure,
        sameSite: "strict",
        path: "/",
        maxAge: "30 days",
      }),
    );
  const member = Effect.flatMap(accessEffect, (access) =>
    Option.match(access.member, {
      onNone: () =>
        Effect.fail(authFailure("Complete GitHub sign-in to add the first member.", 409)),
      onSome: Effect.succeed,
    }),
  );
  const endpoints = [
    HttpRouter.route("GET", "/api/health", json({ ok: true })),
    HttpRouter.route("GET", "/api/auth/info", json({ github: auth.githubAvailable })),
    HttpRouter.route(
      "GET",
      "/api/auth/session",
      Effect.gen(function* () {
        const access = yield* accessEffect;
        return json({ member: Option.getOrNull(access.member), csrf: access.csrf });
      }),
    ),
    HttpRouter.route(
      "POST",
      "/api/auth/link",
      Effect.gen(function* () {
        const access = yield* accessEffect;
        if (access.credential !== "local")
          return yield* authFailure("Run usine sign-in-link on the instance machine.", 403);
        return json({ url: yield* auth.link });
      }),
    ),
    HttpRouter.route(
      "POST",
      "/api/auth/link/consume",
      Effect.gen(function* () {
        const { token } = yield* body(Schema.Struct({ token: Schema.NonEmptyString }));
        return session(
          yield* auth.consumeLink(token),
          json({ ok: true, bootstrap: (yield* store.members).length === 0 }),
        );
      }),
    ),
    HttpRouter.route(
      "GET",
      "/api/auth/github",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const access = yield* auth.authenticate(secretOf(request)).pipe(Effect.option);
        const bootstrap = Option.isSome(access) && Option.isNone(access.value.member);
        const result = yield* auth.startWeb(bootstrap);
        return HttpServerResponse.redirect(result.url).pipe(
          HttpServerResponse.setCookieUnsafe(STATE_COOKIE, Redacted.value(result.state), {
            httpOnly: true,
            secure,
            sameSite: "lax",
            path: "/api/auth",
            maxAge: "10 minutes",
          }),
        );
      }),
    ),
    HttpRouter.route(
      "GET",
      "/api/auth/callback",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const params = new URL(request.url, auth.origin).searchParams;
        const state = params.get("state");
        const code = params.get("code");
        if (state === null || code === null || request.cookies[STATE_COOKIE] !== state)
          return yield* authFailure("GitHub sign-in could not be verified. Start sign-in again.");
        return session(yield* auth.finishWeb(state, code), HttpServerResponse.redirect("/")).pipe(
          HttpServerResponse.expireCookieUnsafe(STATE_COOKIE, { path: "/api/auth" }),
        );
      }).pipe(
        Effect.catchTag("AuthError", (error) =>
          Effect.succeed(
            HttpServerResponse.redirect(`/sign-in?error=${encodeURIComponent(error.message)}`),
          ),
        ),
      ),
    ),
    HttpRouter.route(
      "POST",
      "/api/auth/device",
      Effect.gen(function* () {
        const { name } = yield* body(Schema.Struct({ name: TokenName }));
        const started = yield* auth.startDevice(name);
        return json({ ...started, id: Redacted.value(started.id) });
      }),
    ),
    HttpRouter.route(
      "POST",
      "/api/auth/device/poll",
      Effect.gen(function* () {
        const { id } = yield* body(Schema.Struct({ id: Schema.NonEmptyString }));
        const result = yield* auth.pollDevice(id);
        return Option.match(result, {
          onNone: () => json({ pending: true }),
          onSome: (issued) => json({ token: Redacted.value(issued.secret) }),
        });
      }),
    ),
    HttpRouter.route(
      "POST",
      "/api/auth/sign-out",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        yield* auth.signOut(secretOf(request));
        return json({ ok: true }).pipe(
          HttpServerResponse.expireCookieUnsafe(COOKIE, { path: "/" }),
          HttpServerResponse.expireCookieUnsafe("usine_csrf", { path: "/" }),
        );
      }),
    ),
    HttpRouter.route(
      "GET",
      "/api/members",
      Effect.asVoid(member).pipe(
        Effect.andThen(store.members),
        Effect.map((members) => json(members)),
      ),
    ),
    HttpRouter.route(
      "POST",
      "/api/members",
      Effect.gen(function* () {
        const actor = yield* member;
        const { login } = yield* body(Schema.Struct({ login: OperatorLogin }));
        const identity = yield* github.lookup(login);
        yield* store.add(
          new Member({
            ...identity,
            addedAt: yield* Clock.currentTimeMillis,
            addedBy: actor.login,
          }),
          false,
        );
        return json({ ok: true });
      }),
    ),
    HttpRouter.route(
      "DELETE",
      "/api/members/:id",
      Effect.gen(function* () {
        yield* member;
        const { id } = yield* HttpRouter.params;
        const parsed = yield* Schema.decodeUnknownEffect(
          Schema.NumberFromString.pipe(Schema.decodeTo(GitHubUserId)),
        )(id).pipe(Effect.mapError(() => authFailure("Invalid member ID.", 400)));
        yield* store.remove(parsed);
        return json({ ok: true });
      }),
    ),
    HttpRouter.route(
      "GET",
      "/api/tokens",
      Effect.gen(function* () {
        const actor = yield* member;
        const tokens = yield* store.tokens(actor.id);
        return json(
          tokens.map(({ id, name, createdAt, lastUsedAt, kind }) => ({
            id,
            name,
            createdAt,
            lastUsedAt,
            kind,
          })),
        );
      }),
    ),
    HttpRouter.route(
      "DELETE",
      "/api/tokens/:id",
      Effect.gen(function* () {
        const actor = yield* member;
        const { id } = yield* HttpRouter.params;
        const parsed = yield* Schema.decodeUnknownEffect(TokenId)(id).pipe(
          Effect.mapError(() => authFailure("Invalid token ID.", 400)),
        );
        yield* store.revoke(actor.id, parsed);
        return json({ ok: true });
      }),
    ),
  ] satisfies ReadonlyArray<HttpRouter.Route<AuthError>>;
  const guard = HttpRouter.middleware<{ handles: AuthError }>()((handler) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const access = yield* auth.authenticate(secretOf(request));
      const bearer = request.headers.authorization?.startsWith("Bearer ") === true;
      if (!bearer && request.method !== "GET" && request.headers["x-usine-csrf"] !== access.csrf)
        return yield* authFailure(
          "The session could not verify this request. Refresh the page and try again.",
          403,
        );
      return yield* handler.pipe(
        Effect.provideService(RequestAccess, Option.some(access)),
        Effect.provideService(
          ActingMember,
          Option.map(access.member, ({ login }) => login),
        ),
      );
    }).pipe(
      Effect.catchTag("AuthError", (error) =>
        Effect.logWarning("Authentication request refused", { status: error.status }).pipe(
          Effect.as(json({ error: "AuthenticationError", message: error.message }, error.status)),
        ),
      ),
      Effect.map(sensitive),
    ),
  );
  const publicGuard = HttpRouter.middleware<{ handles: AuthError }>()((handler) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (
        request.method !== "GET" &&
        request.headers.origin !== undefined &&
        request.headers.origin !== auth.origin
      )
        return yield* authFailure("Cross-site sign-in requests are not allowed.", 403);
      return yield* handler;
    }).pipe(
      Effect.catchTag("AuthError", (error) =>
        Effect.logWarning("Sign-in request refused", { status: error.status }).pipe(
          Effect.as(json({ error: "AuthenticationError", message: error.message }, error.status)),
        ),
      ),
      Effect.map(sensitive),
    ),
  );
  const routes = Layer.merge(
    HttpRouter.addAll(endpoints.filter((route) => PUBLIC.has(route.path))).pipe(
      Layer.provide(publicGuard.layer),
    ),
    HttpRouter.addAll(endpoints.filter((route) => !PUBLIC.has(route.path))).pipe(
      Layer.provide(guard.layer),
    ),
  );
  return { endpoints, routes, guard };
};
