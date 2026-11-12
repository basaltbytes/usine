import { MemberAccess } from "./access.ts";
import {
  administratorPermissions,
  intersectPermissions,
  permits,
  type PermissionGrant,
} from "@usine/core/access";
import { type UiOrigin } from "@usine/config/factory";
import { OperatorLogin } from "@usine/core/operator";
import { Clock, Context, Effect, Layer, Option, Redacted, Crypto } from "effect";
import { GitHubSignIn } from "./github.ts";
import {
  AuthError,
  authFailure,
  GitHubIdentity,
  type GitHubUserId,
  InstanceToken,
  Member,
  NO_EXPIRY,
  OperationCeilingChange,
  type OperationId,
  TokenId,
  TokenName,
  type TokenHash,
} from "./model.ts";
import { AuthStore } from "./store.ts";
import { randomSecret, secretHash } from "./crypto.ts";

export interface Access {
  readonly credential: "local" | "bootstrap" | "member";
  readonly member: Option.Option<Member>;
  readonly token: Option.Option<InstanceToken>;
  readonly csrf: string;
  readonly permissions: ReadonlyArray<PermissionGrant>;
  /** The operations a device token may call; `None` when the credential has no operation ceiling. */
  readonly operations: Option.Option<ReadonlyArray<OperationId>>;
}
/** A device token that a member creates for a client. */
export interface TokenRequest {
  readonly name: TokenName;
  readonly scopes: ReadonlyArray<PermissionGrant>;
  readonly operations: Option.Option<ReadonlyArray<OperationId>>;
  /** Epoch milliseconds after which the token stops authenticating. */
  readonly expiresAt: Option.Option<number>;
}
export interface IssuedToken {
  readonly secret: Redacted.Redacted<string>;
  readonly csrf: string;
}
interface WebState {
  readonly expires: number;
  readonly bootstrap: boolean;
}
interface DeviceState {
  readonly expires: number;
  readonly code: Redacted.Redacted<string>;
  readonly nextPoll: number;
  readonly interval: number;
  readonly name: TokenName;
}
const TEN_MINUTES = 600_000;
const SESSION_LIFETIME = 30 * 24 * 60 * 60 * 1000;

export class Authentication extends Context.Service<
  Authentication,
  {
    readonly createToken: (
      secret: string,
      request: TokenRequest,
    ) => Effect.Effect<IssuedToken, AuthError>;
    readonly setScopes: (
      secret: string,
      id: TokenId,
      scopes: ReadonlyArray<PermissionGrant>,
      operations: OperationCeilingChange,
    ) => Effect.Effect<void, AuthError>;
    readonly removeMember: (id: GitHubUserId) => Effect.Effect<void, AuthError>;
    readonly origin: UiOrigin;
    readonly origins: ReadonlyArray<UiOrigin>;
    readonly githubAvailable: Effect.Effect<boolean>;
    readonly authenticate: (secret: string) => Effect.Effect<Access, AuthError>;
    readonly link: Effect.Effect<string, AuthError>;
    readonly consumeLink: (secret: string) => Effect.Effect<IssuedToken, AuthError>;
    readonly startWeb: (
      bootstrap: boolean,
    ) => Effect.Effect<
      { readonly state: Redacted.Redacted<string>; readonly url: string },
      AuthError
    >;
    readonly finishWeb: (state: string, code: string) => Effect.Effect<IssuedToken, AuthError>;
    readonly startDevice: (name: TokenName) => Effect.Effect<
      {
        readonly id: Redacted.Redacted<string>;
        readonly userCode: string;
        readonly verificationUri: string;
        readonly interval: number;
      },
      AuthError
    >;
    readonly pollDevice: (id: string) => Effect.Effect<Option.Option<IssuedToken>, AuthError>;
    readonly limit: (endpoint: string) => Effect.Effect<void, AuthError>;
    readonly signOut: (secret: string) => Effect.Effect<void, AuthError>;
  }
>()("@usine/server/auth/authentication") {}

export const authenticationLayer = (options: {
  readonly origin: UiOrigin;
  readonly origins: ReadonlyArray<UiOrigin>;
  readonly localToken: Redacted.Redacted<string>;
}) =>
  Layer.effect(
    Authentication,
    Effect.gen(function* () {
      const store = yield* AuthStore;
      const crypto = yield* Crypto.Crypto;
      const access = yield* MemberAccess;
      const github = yield* GitHubSignIn;
      const links = new Map<
        TokenHash,
        { readonly expires: number; readonly memberId: Option.Option<GitHubUserId> }
      >();
      const bootstrapSessions = new Map<TokenHash, number>();
      const states = new Map<TokenHash, WebState>();
      const devices = new Map<TokenHash, DeviceState>();
      const limits = new Map<string, { readonly until: number; readonly count: number }>();
      const localHash = secretHash(Redacted.value(options.localToken));
      const csrf = (secret: string) => secretHash(`csrf:${secret}`);
      const callback = `${options.origin}/api/auth/callback`;
      const prune = (now: number) => {
        for (const [key, link] of links) if (link.expires <= now) links.delete(key);
        for (const [key, expires] of bootstrapSessions)
          if (expires <= now) bootstrapSessions.delete(key);
        for (const [key, value] of states) if (value.expires <= now) states.delete(key);
        for (const [key, value] of devices)
          if (value.expires <= now) {
            Redacted.wipeUnsafe(value.code);
            devices.delete(key);
          }
      };
      const issue = Effect.fn("Authentication.issue")(function* (
        member: Member,
        kind: InstanceToken["kind"],
        name: TokenName,
        requested: Option.Option<TokenRequest> = Option.none(),
      ) {
        yield* Effect.annotateCurrentSpan({ memberId: member.id, kind });
        const secret = randomSecret();
        const now = yield* Clock.currentTimeMillis;
        const tokenId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
        const token = InstanceToken.make({
          id: TokenId.make(tokenId),
          memberId: member.id,
          hash: secretHash(Redacted.value(secret)),
          name,
          scopes:
            kind === "session"
              ? []
              : yield* Option.match(requested, {
                  onNone: () => access.permissions(member.id),
                  onSome: ({ scopes }) => Effect.succeed(scopes),
                }),
          kind,
          createdAt: now,
          lastUsedAt: now,
          expiresAt:
            kind === "session"
              ? now + SESSION_LIFETIME
              : Option.getOrElse(
                  Option.flatMap(requested, ({ expiresAt }) => expiresAt),
                  () => NO_EXPIRY,
                ),
          operations: Option.flatMap(requested, ({ operations }) => operations),
        });
        yield* store.issue(token);
        yield* Effect.logInfo("Instance token issued", {
          memberId: member.id,
          tokenId: token.id,
          kind,
          operationCeiling: Option.isSome(token.operations),
          expires: token.expiresAt !== NO_EXPIRY,
        });
        return { secret, csrf: csrf(Redacted.value(secret)) };
      });
      const memberFor = Effect.fn("Authentication.memberFor")(function* (
        identity: GitHubIdentity,
        bootstrap: boolean,
      ) {
        yield* Effect.annotateCurrentSpan({ githubUserId: identity.id, bootstrap });
        const members = yield* store.members;
        const member = members.find((entry) => entry.id === identity.id);
        if (member !== undefined) return yield* store.rename(identity);
        if (bootstrap && members.length === 0) {
          const first = Member.make({
            ...identity,
            addedAt: yield* Clock.currentTimeMillis,
            addedBy: identity.login,
          });
          yield* access.enroll(first);
          bootstrapSessions.clear();
          return first;
        }
        yield* Effect.logWarning("GitHub sign-in refused for a non-member", {
          githubUserId: identity.id,
        });
        return yield* authFailure(
          "This GitHub login is not a member. Ask an instance admin to add you.",
          403,
        );
      });
      const authenticate = Effect.fn("Authentication.authenticate")(function* (secret: string) {
        const now = yield* Clock.currentTimeMillis;
        prune(now);
        const hash = secretHash(secret);
        if (hash === localHash || bootstrapSessions.has(hash)) {
          const member = Option.none<Member>();
          return {
            credential: hash === localHash ? ("local" as const) : ("bootstrap" as const),
            member,
            token: Option.none(),
            csrf: csrf(secret),
            permissions: hash === localHash ? administratorPermissions : [],
            operations: Option.none(),
          };
        }
        const found = yield* store.authenticate(hash, now);
        if (Option.isNone(found)) return yield* authFailure("Sign in to continue.");
        const { member, token } = found.value;
        yield* Effect.annotateCurrentSpan({
          memberId: member.id,
          tokenId: token.id,
          kind: token.kind,
        });
        const grants = yield* access.permissions(member.id);
        const permissions =
          token.kind === "session" ? grants : intersectPermissions(grants, token.scopes);
        yield* Effect.logDebug("Member permissions resolved", {
          memberId: member.id,
          tokenId: token.id,
          kind: token.kind,
          permissionCount: permissions.length,
        });
        return {
          credential: "member" as const,
          member: Option.some(member),
          token: Option.some(token),
          csrf: csrf(secret),
          permissions,
          operations: token.kind === "device" ? token.operations : Option.none(),
        };
      });
      // A caller with an operation ceiling cannot issue or widen a ceiling beyond its own.
      const narrowCeiling = Effect.fn("Authentication.narrowCeiling")(function* (
        caller: Access,
        requested: Option.Option<ReadonlyArray<OperationId>>,
      ) {
        if (Option.isNone(caller.operations)) return requested;
        const ceiling = caller.operations.value;
        if (
          Option.isSome(requested) &&
          requested.value.every((operation) => ceiling.includes(operation))
        )
          return requested;
        yield* Effect.logWarning("Token operations refused: they exceed the caller's ceiling", {
          memberId: Option.getOrUndefined(Option.map(caller.member, ({ id }) => id)),
        });
        return yield* authFailure("Token operations exceed your token's operations.", 403);
      });
      const limit = Effect.fn("Authentication.limit")(function* (endpoint: string) {
        const now = yield* Clock.currentTimeMillis;
        prune(now);
        const previous = limits.get(endpoint);
        const window =
          previous === undefined || previous.until <= now
            ? { until: now + 60_000, count: 0 }
            : previous;
        if (window.count >= 60) {
          yield* Effect.logWarning("Sign-in rate limit reached", { endpoint });
          return yield* authFailure("Too many sign-in requests. Try again in a minute.", 429);
        }
        limits.set(endpoint, { ...window, count: window.count + 1 });
      });
      return Authentication.of({
        createToken: Effect.fn("Authentication.createToken")(function* (secret, request) {
          const caller = yield* authenticate(secret);
          if (Option.isNone(caller.member)) {
            yield* Effect.logWarning("Token creation refused for a non-member credential", {
              credential: caller.credential,
            });
            return yield* authFailure("Sign in as a member to create a token.", 403);
          }
          yield* Effect.annotateCurrentSpan({ memberId: caller.member.value.id });
          if (Option.isSome(caller.token))
            yield* Effect.annotateCurrentSpan({ callerTokenId: caller.token.value.id });
          if (
            !request.scopes.every((grant) =>
              permits(caller.permissions, grant.permission, grant.scope),
            )
          ) {
            yield* Effect.logWarning("Token creation refused: scopes exceed caller permissions", {
              memberId: caller.member.value.id,
              requestedScopeCount: request.scopes.length,
            });
            return yield* authFailure("Token scopes exceed your permissions.", 403);
          }
          const operations = yield* narrowCeiling(caller, request.operations);
          const now = yield* Clock.currentTimeMillis;
          if (Option.exists(request.expiresAt, (expiresAt) => expiresAt <= now)) {
            yield* Effect.logWarning("Token creation refused: expiry is not in the future", {
              memberId: caller.member.value.id,
            });
            return yield* authFailure("Set a token expiry in the future.", 400);
          }
          // A device token can't issue a token that outlives it.
          const callerExpiry = Option.filter(
            caller.token,
            ({ kind, expiresAt }) => kind === "device" && expiresAt !== NO_EXPIRY,
          ).pipe(Option.map(({ expiresAt }) => expiresAt));
          if (
            Option.isSome(callerExpiry) &&
            !Option.exists(request.expiresAt, (expiresAt) => expiresAt <= callerExpiry.value)
          ) {
            yield* Effect.logWarning("Token creation refused: expiry exceeds the caller's", {
              memberId: caller.member.value.id,
            });
            return yield* authFailure("Set a token expiry no later than your token's expiry.", 403);
          }
          return yield* issue(
            caller.member.value,
            "device",
            request.name,
            Option.some({ ...request, operations }),
          );
        }),
        setScopes: Effect.fn("Authentication.setScopes")(function* (secret, id, scopes, change) {
          yield* Effect.annotateCurrentSpan({ tokenId: id });
          const caller = yield* authenticate(secret);
          if (Option.isNone(caller.member)) {
            yield* Effect.logWarning("Token scope change refused for a non-member credential", {
              credential: caller.credential,
              tokenId: id,
            });
            return yield* authFailure("Sign in as a member to change token scopes.", 403);
          }
          yield* Effect.annotateCurrentSpan({ memberId: caller.member.value.id });
          if (Option.isSome(caller.token))
            yield* Effect.annotateCurrentSpan({ callerTokenId: caller.token.value.id });
          const tokens = yield* store.tokens(caller.member.value.id);
          const current = tokens.find((token) => token.id === id);
          if (current?.kind === "session") {
            yield* Effect.logWarning("Scope change refused for a browser session", {
              memberId: caller.member.value.id,
              tokenId: id,
            });
            return yield* authFailure(
              "Browser sessions follow role bindings. Only device tokens have editable scopes.",
              400,
            );
          }
          if (
            !scopes.every((grant) => permits(caller.permissions, grant.permission, grant.scope))
          ) {
            yield* Effect.logWarning(
              "Token scope change refused: scopes exceed caller permissions",
              {
                memberId: caller.member.value.id,
                tokenId: id,
                requestedScopeCount: scopes.length,
              },
            );
            return yield* authFailure("Token scopes exceed your permissions.", 403);
          }
          // The target's resulting ceiling must fit the caller's, including a ceiling the edit keeps.
          yield* OperationCeilingChange.$match(change, {
            Keep: () =>
              current === undefined ? Effect.void : narrowCeiling(caller, current.operations),
            Remove: () => narrowCeiling(caller, Option.none()),
            Replace: ({ operations }) => narrowCeiling(caller, Option.some(operations)),
          });
          yield* store.setScopes(caller.member.value.id, id, scopes, change);
        }),
        removeMember: access.remove,
        origin: options.origin,
        origins: [options.origin, ...options.origins],
        githubAvailable: github.available,
        authenticate,
        limit,
        link: Effect.gen(function* () {
          yield* limit("link");
          const secret = randomSecret();
          links.set(secretHash(Redacted.value(secret)), {
            expires: (yield* Clock.currentTimeMillis) + TEN_MINUTES,
            memberId: Option.fromUndefinedOr((yield* store.members)[0]?.id),
          });
          yield* Effect.logInfo("One-time sign-in link issued");
          return `${options.origin}/sign-in#link=${Redacted.value(secret)}`;
        }),
        consumeLink: Effect.fn("Authentication.consumeLink")(function* (secret) {
          const hash = secretHash(secret);
          const link = links.get(hash);
          links.delete(hash);
          if (link === undefined || link.expires <= (yield* Clock.currentTimeMillis)) {
            yield* limit("invalid-consume-link");
            return yield* authFailure(
              "This sign-in link expired or was already used. Run usine sign-in-link for a new link.",
            );
          }
          const members = yield* store.members;
          if (Option.isSome(link.memberId)) {
            const memberId = link.memberId.value;
            const member = members.find((entry) => entry.id === memberId);
            if (member === undefined)
              return yield* authFailure("This sign-in link is no longer valid.");
            return yield* issue(member, "session", TokenName.make("Browser"));
          }
          if (members.length > 0) return yield* authFailure("Setup has already completed.");
          const session = randomSecret();
          bootstrapSessions.set(
            secretHash(Redacted.value(session)),
            (yield* Clock.currentTimeMillis) + SESSION_LIFETIME,
          );
          yield* Effect.logInfo("Setup session opened with a one-time link");
          return { secret: session, csrf: csrf(Redacted.value(session)) };
        }),
        startWeb: Effect.fn("Authentication.startWeb")(function* (bootstrap) {
          yield* limit("web");
          const state = randomSecret();
          const url = yield* github.authorizeUrl(Redacted.value(state), callback);
          states.set(secretHash(Redacted.value(state)), {
            expires: (yield* Clock.currentTimeMillis) + TEN_MINUTES,
            bootstrap,
          });
          return { state, url };
        }),
        finishWeb: Effect.fn("Authentication.finishWeb")(function* (state, code) {
          const hash = secretHash(state);
          const pending = states.get(hash);
          if (pending === undefined || pending.expires <= (yield* Clock.currentTimeMillis)) {
            yield* limit("invalid-callback");
            return yield* authFailure("The GitHub sign-in expired. Start sign-in again.");
          }
          yield* limit("callback");
          states.delete(hash);
          const githubIdentity = yield* github.web(code, callback);
          const member = yield* memberFor(githubIdentity, pending.bootstrap);
          return yield* issue(member, "session", TokenName.make("Browser"));
        }),
        startDevice: Effect.fn("Authentication.startDevice")(function* (name) {
          yield* limit("device");
          const response = yield* github.device;
          const id = randomSecret();
          const now = yield* Clock.currentTimeMillis;
          devices.set(secretHash(Redacted.value(id)), {
            expires: now + response.expires_in * 1000,
            code: response.device_code,
            nextPoll: now + response.interval * 1000,
            interval: response.interval,
            name,
          });
          return {
            id,
            userCode: response.user_code,
            verificationUri: response.verification_uri,
            interval: response.interval,
          };
        }),
        pollDevice: Effect.fn("Authentication.pollDevice")(function* (id) {
          const hash = secretHash(id);
          const state = devices.get(hash);
          if (state === undefined || state.expires <= (yield* Clock.currentTimeMillis)) {
            yield* limit("invalid-device-poll");
            return yield* authFailure("Device sign-in expired. Start sign-in again.");
          }
          const now = yield* Clock.currentTimeMillis;
          if (state.nextPoll > now)
            return yield* authFailure("Wait before checking device sign-in again.", 429);
          yield* limit("device-poll");
          devices.delete(hash);
          const identity = yield* github.poll(state.code).pipe(
            Effect.catchTag("AuthError", (error) => {
              if (error.status === 429)
                devices.set(hash, {
                  ...state,
                  interval: state.interval + 5,
                  nextPoll: now + (state.interval + 5) * 1000,
                });
              else Redacted.wipeUnsafe(state.code);
              return Effect.fail(error);
            }),
          );
          if (Option.isNone(identity)) {
            devices.set(hash, { ...state, nextPoll: now + state.interval * 1000 });
            return Option.none();
          }
          Redacted.wipeUnsafe(state.code);
          const member = yield* memberFor(identity.value, false);
          const token = yield* issue(member, "device", state.name);
          return Option.some(token);
        }),
        signOut: Effect.fn("Authentication.signOut")(function* (secret) {
          const access = yield* authenticate(secret);
          bootstrapSessions.delete(secretHash(secret));
          if (Option.isSome(access.token))
            yield* store.revoke(access.token.value.memberId, access.token.value.id);
          yield* Effect.logInfo("Session signed out");
        }),
      });
    }),
  );

export const seedOperator = Effect.fn("Authentication.seedOperator")(function* (
  login: Option.Option<OperatorLogin>,
) {
  const store = yield* AuthStore;
  if ((yield* store.members).length > 0 || Option.isNone(login)) {
    yield* Effect.logDebug(
      "Operator enrollment skipped: members exist or no operator is configured",
    );
    return;
  }
  yield* Effect.annotateCurrentSpan({ login: login.value });
  const github = yield* GitHubSignIn;
  const identity = yield* github.lookup(login.value).pipe(
    Effect.asSome,
    Effect.catchTag("AuthError", (error) =>
      Effect.logWarning("Operator enrollment deferred until the next start", {
        login: login.value,
        status: error.status,
      }).pipe(Effect.as(Option.none())),
    ),
  );
  if (Option.isNone(identity)) return;
  yield* (yield* MemberAccess).enroll(
    Member.make({
      ...identity.value,
      addedBy: identity.value.login,
      addedAt: yield* Clock.currentTimeMillis,
    }),
  );
});
