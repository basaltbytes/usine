import { ProviderApi } from "../providers/api.ts";
import { jsonKey } from "@usine/core/json-key";
import type { SqliteReader } from "@usine/engine/local-sqlite";
import { ChangeAccess } from "../changes/access.ts";
import { SetupApi, setupPermissions } from "../setup/api.ts";
import { permits, InstanceScope, RequestPermissions } from "@usine/core/access";
import { ActingMember, localActor } from "@usine/core/operator";
import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Authentication, type Access, type IssuedToken } from "./authentication.ts";
import { GitHubSignIn } from "./github.ts";
import { AuthError, authFailure, GitHubUserId, Member, TokenId } from "./model.ts";
import {
  AuthApi,
  authPermissions,
  publicAuthPaths,
  ConsumeLink,
  StartDevice,
  PollDevice,
  AddMember,
  CreateToken,
  TokenScopes,
} from "./api.ts";
import { publicOperatorPaths } from "../openapi.ts";
import { AuthStore } from "./store.ts";

export interface AuthServices {
  readonly authentication: Authentication["Service"];
  readonly store: AuthStore["Service"];
  readonly github: GitHubSignIn["Service"];
  readonly sqliteReader?: SqliteReader["Service"];
}
const RequestAccess = Context.Reference<Option.Option<Access>>("@usine/server/RequestAccess", {
  defaultValue: Option.none,
});
const accessEffect = Effect.flatMap(RequestAccess, (access) =>
  Effect.fromOption(access, () => authFailure("Sign in to continue.")),
);
const COOKIE = "usine_session";
const STATE_COOKIE = "usine_sign_in_state";
const json = <A>(body: A, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });
const secretOf = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.authorization?.startsWith("Bearer ") === true
    ? request.headers.authorization.slice(7)
    : (request.cookies[COOKIE] ?? "");
const body = <A, I>(schema: Schema.Codec<A, I>) =>
  HttpServerRequest.schemaBodyJson(schema, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => authFailure("Invalid request.", 400)),
  );
const sensitive = HttpServerResponse.setHeaders({
  "cache-control": "no-store",
});

export const authenticatedRoutes = (services: AuthServices) => {
  const { authentication: auth, store, github } = services;
  const secure = auth.origin.startsWith("https:");
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
    Effect.fromOption(access.member, () =>
      authFailure("Complete GitHub sign-in to add the first member.", 409),
    ),
  );
  const endpoints = [
    HttpRouter.route(
      AuthApi.endpoints.health.method,
      AuthApi.endpoints.health.path,
      services.sqliteReader === undefined
        ? json({ ok: true })
        : Effect.map(services.sqliteReader.state, (sqliteReader) =>
            json({ ok: true, sqliteReader }),
          ),
    ),
    HttpRouter.route(
      AuthApi.endpoints.info.method,
      AuthApi.endpoints.info.path,
      Effect.map(auth.githubAvailable, (github) => json({ github })),
    ),
    HttpRouter.route(
      AuthApi.endpoints.session.method,
      AuthApi.endpoints.session.path,
      Effect.gen(function* () {
        const access = yield* accessEffect;
        return json({
          member: Option.getOrNull(access.member),
          csrf: access.csrf,
          permissions: access.permissions,
        });
      }),
    ),
    HttpRouter.route(
      AuthApi.endpoints.link.method,
      AuthApi.endpoints.link.path,
      Effect.gen(function* () {
        const access = yield* accessEffect;
        if (access.credential !== "local")
          return yield* authFailure("Run usine sign-in-link on the instance machine.", 403);
        return json({ url: yield* auth.link });
      }),
    ),
    HttpRouter.route(
      AuthApi.endpoints.consumeLink.method,
      AuthApi.endpoints.consumeLink.path,
      Effect.gen(function* () {
        const { token } = yield* body(ConsumeLink);
        const member = yield* auth.consumeLink(token);
        return session(member, json({ ok: true, bootstrap: (yield* store.members).length === 0 }));
      }),
    ),
    HttpRouter.route(
      AuthApi.endpoints.github.method,
      AuthApi.endpoints.github.path,
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
      AuthApi.endpoints.callback.method,
      AuthApi.endpoints.callback.path,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const params = new URL(request.url, auth.origin).searchParams;
        const state = params.get("state");
        const code = params.get("code");
        if (state === null || code === null || request.cookies[STATE_COOKIE] !== state)
          return yield* authFailure("GitHub sign-in could not be verified. Start sign-in again.");
        const firstSignIn = (yield* store.members).length === 0;
        const member = yield* auth.finishWeb(state, code);
        return session(member, HttpServerResponse.redirect(firstSignIn ? "/setup" : "/")).pipe(
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
      AuthApi.endpoints.device.method,
      AuthApi.endpoints.device.path,
      Effect.gen(function* () {
        const { name } = yield* body(StartDevice);
        const started = yield* auth.startDevice(name);
        return json({ ...started, id: Redacted.value(started.id) });
      }),
    ),
    HttpRouter.route(
      AuthApi.endpoints.pollDevice.method,
      AuthApi.endpoints.pollDevice.path,
      Effect.gen(function* () {
        const { id } = yield* body(PollDevice);
        const result = yield* auth.pollDevice(id);
        return Option.match(result, {
          onNone: () => json({ pending: true }),
          onSome: (issued) => json({ token: Redacted.value(issued.secret) }),
        });
      }),
    ),
    HttpRouter.route(
      AuthApi.endpoints.signOut.method,
      AuthApi.endpoints.signOut.path,
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
      AuthApi.endpoints.members.method,
      AuthApi.endpoints.members.path,
      store.members.pipe(Effect.map((members) => json(members))),
    ),
    HttpRouter.route(
      AuthApi.endpoints.addMember.method,
      AuthApi.endpoints.addMember.path,
      Effect.gen(function* () {
        const access = yield* accessEffect;
        const actor =
          access.credential === "local"
            ? localActor
            : yield* Effect.map(member, ({ login }) => login);
        const { login } = yield* body(AddMember);
        const identity = yield* github.lookup(login);
        yield* store.add(
          Member.make({
            ...identity,
            addedAt: yield* Clock.currentTimeMillis,
            addedBy: actor,
          }),
          false,
        );
        return json({ ok: true });
      }),
    ),
    HttpRouter.route(
      AuthApi.endpoints.removeMember.method,
      AuthApi.endpoints.removeMember.path,
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.params;
        const parsed = yield* Schema.decodeUnknownEffect(
          Schema.FiniteFromString.pipe(Schema.decodeTo(GitHubUserId)),
        )(id).pipe(Effect.mapError(() => authFailure("Invalid member ID.", 400)));
        yield* auth.removeMember(parsed);
        return json({ ok: true });
      }),
    ),
    HttpRouter.route(
      AuthApi.endpoints.tokens.method,
      AuthApi.endpoints.tokens.path,
      Effect.gen(function* () {
        const actor = yield* member;
        const tokens = yield* store.tokens(actor.id);
        return json(
          tokens.map(({ id, name, createdAt, lastUsedAt, kind, scopes }) => ({
            id,
            name,
            createdAt,
            lastUsedAt,
            kind,
            scopes,
          })),
        );
      }),
    ),
    HttpRouter.route(
      AuthApi.endpoints.createToken.method,
      AuthApi.endpoints.createToken.path,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const input = yield* body(CreateToken);
        const issued = yield* auth.createToken(secretOf(request), input.name, input.scopes);
        return json({ token: Redacted.value(issued.secret) });
      }),
    ),
    HttpRouter.route(
      AuthApi.endpoints.setScopes.method,
      AuthApi.endpoints.setScopes.path,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const { id } = yield* HttpRouter.params;
        const tokenId = yield* Schema.decodeUnknownEffect(TokenId)(id).pipe(
          Effect.mapError(() => authFailure("Invalid token ID.", 400)),
        );
        const { scopes } = yield* body(TokenScopes);
        yield* auth.setScopes(secretOf(request), tokenId, scopes);
        return json({ ok: true });
      }),
    ),
    HttpRouter.route(
      AuthApi.endpoints.revokeToken.method,
      AuthApi.endpoints.revokeToken.path,
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
      const { route } = yield* HttpRouter.RouteContext;
      if (route.method === "GET" && publicOperatorPaths.has(route.path)) {
        yield* Effect.logDebug("Serving public operator API route", { route: route.path });
        return yield* handler;
      }
      const request = yield* HttpServerRequest.HttpServerRequest;
      const access = yield* auth.authenticate(secretOf(request));
      const authEndpoint = Object.values(AuthApi.endpoints).find(
        (endpoint) => endpoint.method === route.method && endpoint.path === route.path,
      );
      const setupEndpoint = Object.values(SetupApi.endpoints).find(
        (endpoint) => endpoint.method === route.method && endpoint.path === route.path,
      );
      const providerEndpoint = Object.values(ProviderApi.endpoints).some(
        (endpoint) => endpoint.method === route.method && endpoint.path === route.path,
      );
      const requirement = providerEndpoint
        ? "setup"
        : authEndpoint === undefined
          ? setupEndpoint === undefined
            ? undefined
            : setupPermissions[setupEndpoint.identifier]
          : authPermissions[authEndpoint.identifier];
      if (requirement === "local" && access.credential !== "local")
        return yield* authFailure("Run usine sign-in-link on the instance machine.", 403);
      if (requirement === "admin" && !permits(access.permissions, "admin", InstanceScope.make()))
        return yield* authFailure("Instance admin access is required.", 403);
      if (
        requirement === "setup" &&
        access.credential !== "bootstrap" &&
        !permits(access.permissions, "admin", InstanceScope.make())
      )
        return yield* authFailure("Instance admin access is required.", 403);
      if (
        access.credential === "bootstrap" &&
        requirement !== "setup" &&
        route.path !== "/api/auth/session" &&
        route.path !== "/api/auth/sign-out"
      )
        return yield* authFailure("Complete setup before using the operator API.", 403);
      if (
        requirement === "tokens" &&
        Option.isSome(access.token) &&
        access.token.value.kind === "device" &&
        !permits(access.permissions, "admin", InstanceScope.make())
      )
        return yield* authFailure("Sign in with a browser session to manage tokens.", 403);
      const bearer = request.headers.authorization?.startsWith("Bearer ") === true;
      if (!bearer && request.method !== "GET" && request.headers["x-usine-csrf"] !== access.csrf)
        return yield* authFailure(
          "The session could not verify this request. Refresh the page and try again.",
          403,
        );
      return yield* handler.pipe(
        Effect.provideService(RequestPermissions, access.permissions),
        Effect.provideService(
          ChangeAccess,
          auth
            .authenticate(secretOf(request))
            .pipe(
              Effect.flatMap((current) =>
                jsonKey(current.permissions) === jsonKey(access.permissions)
                  ? Effect.void
                  : Effect.fail(authFailure("Permissions changed. Reconnect to continue.", 403)),
              ),
            ),
        ),
        Effect.provideService(RequestAccess, Option.some(access)),
        Effect.provideService(
          ActingMember,
          access.credential === "local"
            ? Option.some(localActor)
            : Option.map(access.member, ({ login }) => login),
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
    handler.pipe(
      Effect.catchTag("AuthError", (error) =>
        Effect.logWarning("Sign-in request refused", { status: error.status }).pipe(
          Effect.as(json({ error: "AuthenticationError", message: error.message }, error.status)),
        ),
      ),
      Effect.map(sensitive),
    ),
  );
  const routes = Layer.merge(
    HttpRouter.addAll(endpoints.filter((route) => publicAuthPaths.has(route.path))).pipe(
      Layer.provide(publicGuard.layer),
    ),
    HttpRouter.addAll(endpoints.filter((route) => !publicAuthPaths.has(route.path))).pipe(
      Layer.provide(guard.layer),
    ),
  );
  return { endpoints, routes, guard };
};
