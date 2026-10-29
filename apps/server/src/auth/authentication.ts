import { OperatorLogin } from "@usine/core/operator";
import { Clock, Context, Effect, Layer, Option, Redacted } from "effect";
import { GitHubSignIn } from "./github.ts";
import {
  AuthError,
  authFailure,
  GitHubIdentity,
  type GitHubUserId,
  InstanceToken,
  Member,
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
    readonly origin: string;
    readonly githubAvailable: boolean;
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
>()("@usine/server/Authentication") {}

export const authenticationLayer = (options: {
  readonly origin: string;
  readonly localToken: Redacted.Redacted<string>;
}) =>
  Layer.effect(
    Authentication,
    Effect.gen(function* () {
      const store = yield* AuthStore;
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
      ) {
        yield* Effect.annotateCurrentSpan({ memberId: member.id, kind });
        const secret = randomSecret();
        const now = yield* Clock.currentTimeMillis;
        const token = new InstanceToken({
          id: TokenId.make(crypto.randomUUID()),
          memberId: member.id,
          hash: secretHash(Redacted.value(secret)),
          name,
          kind,
          createdAt: now,
          lastUsedAt: now,
          expiresAt: kind === "session" ? now + SESSION_LIFETIME : Number.MAX_SAFE_INTEGER,
        });
        yield* store.issue(token);
        yield* Effect.logInfo("Instance token issued", {
          memberId: member.id,
          tokenId: token.id,
          kind,
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
          const first = new Member({
            ...identity,
            addedAt: yield* Clock.currentTimeMillis,
            addedBy: identity.login,
          });
          yield* store.add(first, true);
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
          const member = Option.fromUndefinedOr((yield* store.members)[0]);
          return {
            credential: hash === localHash ? ("local" as const) : ("bootstrap" as const),
            member,
            token: Option.none(),
            csrf: csrf(secret),
          };
        }
        const found = yield* store.authenticate(hash, now);
        if (Option.isNone(found)) return yield* authFailure("Sign in to continue.");
        return {
          credential: "member" as const,
          member: Option.some(found.value.member),
          token: Option.some(found.value.token),
          csrf: csrf(secret),
        };
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
        origin: options.origin,
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
          const member = yield* memberFor(yield* github.web(code, callback), pending.bootstrap);
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
          return Option.some(yield* issue(member, "device", state.name));
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
    Effect.map(Option.some),
    Effect.catchTag("AuthError", (error) =>
      Effect.logWarning("Operator enrollment deferred until the next start", {
        login: login.value,
        status: error.status,
      }).pipe(Effect.as(Option.none())),
    ),
  );
  if (Option.isNone(identity)) return;
  yield* store.add(
    new Member({
      ...identity.value,
      addedBy: identity.value.login,
      addedAt: yield* Clock.currentTimeMillis,
    }),
    true,
  );
});
