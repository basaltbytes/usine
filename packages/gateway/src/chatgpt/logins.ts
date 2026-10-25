import {
  Context,
  DateTime,
  type Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Ref,
  Schema,
  Semaphore,
  SynchronizedRef,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import type { ChatGptAccess, ChatGptLogin } from "../llm/llm.ts";
import {
  type ChatGptAuthFileError,
  ChatGptTokens,
  idTokenAccount,
  jwtExpiry,
  readAuthFile,
  writeAuthFile,
} from "./auth-file.ts";

/** The OAuth token endpoint that Codex refreshes ChatGPT logins at. */
export const CHATGPT_TOKEN_URL = "https://auth.openai.com/oauth/token";

/** Codex's public OAuth client ID; a login's refresh token works only with it. */
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** An access token that expires within this window is refreshed first, as Codex does. */
const REFRESH_WINDOW = "5 minutes";

/** An access token without an `exp` claim is refreshed when its last refresh is older than this, as Codex does. */
const REFRESH_INTERVAL = "8 days";

/** After a failed refresh, requests fail for this long without calling the token endpoint. */
const FAILURE_BACKOFF = "10 seconds";

/** A 401 for an access token refreshed this recently doesn't start another refresh. */
const REFUSAL_GRACE = "1 minute";

/** The number of rotated refresh tokens remembered, so a reload never goes back to one. */
const RETIRED_TOKENS = 8;

/** The token endpoint's error codes for a refresh token that can't be used again (Codex `classify_refresh_token_failure`). */
const REJECTED_CODES: ReadonlySet<string> = new Set([
  "refresh_token_expired",
  "refresh_token_reused",
  "refresh_token_invalidated",
]);

/**
 * The error for a request whose ChatGPT login has no usable access token: the auth file can't
 * be read (`unreadable`), a refresh failed and is tried again after a short backoff
 * (`refresh-failed`), or the token endpoint rejected the refresh token, which only a new login
 * fixes (`refresh-rejected`). The message names no token and no text from the token endpoint.
 * The reverse proxy answers it with 401.
 */
export class ChatGptLoginUnavailable extends Schema.TaggedError<ChatGptLoginUnavailable>()(
  "ChatGptLoginUnavailable",
  {
    authFile: Schema.String,
    reason: Schema.Literals(["unreadable", "refresh-failed", "refresh-rejected"]),
    message: Schema.String,
  },
) {}

/** A string field that Codex reads as absent when it's null or empty. */
const OptionalText = Schema.optionalKey(Schema.NullOr(Schema.String));

const RefreshResponse = Schema.fromJsonString(
  Schema.Struct({
    access_token: OptionalText,
    refresh_token: OptionalText,
    id_token: OptionalText,
  }),
);
const decodeRefreshResponse = Schema.decodeUnknownOption(RefreshResponse);

const present = (value: string | null | undefined): Option.Option<string> =>
  Option.fromNullishOr(value).pipe(Option.filter((text) => text !== ""));

const decodeErrorText = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ error: Schema.String })),
);
const decodeErrorObject = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ error: Schema.Struct({ code: Schema.String }) })),
);
const decodeErrorCode = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ code: Schema.String })),
);

/** An error code as OAuth servers send them; other text could echo a token, so it's dropped. */
const ERROR_CODE = /^[a-z0-9_.-]{1,64}$/u;

/**
 * Returns the error code in a token endpoint's error body, in lowercase: `error`, `error.code`,
 * or `code`, as Codex reads it. A value that doesn't look like a code is ignored.
 */
const tokenErrorCode = (body: string): Option.Option<string> =>
  decodeErrorText(body).pipe(
    Option.map(({ error }) => error),
    Option.orElse(() => Option.map(decodeErrorObject(body), ({ error }) => error.code)),
    Option.orElse(() => Option.map(decodeErrorCode(body), ({ code }) => code)),
    Option.map((code) => code.toLowerCase()),
    Option.filter((code) => ERROR_CODE.test(code)),
  );

/** Whether a refresh failure means the refresh token can't be used again, as Codex classifies it. */
const isRejection = (status: number, code: Option.Option<string>): boolean =>
  status === 401 ||
  Option.exists(code, (value) => REJECTED_CODES.has(value)) ||
  (status === 400 && Option.contains(code, "invalid_grant"));

interface LoginState {
  readonly tokens: ChatGptTokens;
  /** The upstream refused the current access token, so the next request refreshes first. */
  readonly refused: boolean;
  /** Why the token endpoint rejected the refresh token. Until a reload reads another login, every request fails. */
  readonly rejected: Option.Option<string>;
  /** Refresh tokens this login rotated away from, newest first. */
  readonly retired: ReadonlyArray<string>;
  /** When this process last refreshed the tokens. */
  readonly refreshedAt: Option.Option<DateTime.Utc>;
  /** When the last refresh failed, if it did and none has succeeded since. */
  readonly failedAt: Option.Option<DateTime.Utc>;
}

const fresh = (tokens: ChatGptTokens, retired: ReadonlyArray<string>): LoginState => ({
  tokens,
  refused: false,
  rejected: Option.none(),
  retired,
  refreshedAt: Option.none(),
  failedAt: Option.none(),
});

/** Whether `instant` is less than `duration` before `now`. */
const within = (
  instant: Option.Option<DateTime.Utc>,
  duration: Duration.Input,
  now: DateTime.Utc,
): boolean =>
  Option.exists(instant, (at) => DateTime.isGreaterThan(DateTime.addDuration(at, duration), now));

/** Whether `tokens` must be refreshed at `now` before the next request. */
const refreshDue = (tokens: ChatGptTokens, now: DateTime.Utc): boolean =>
  Option.match(tokens.expiresAt, {
    onSome: (expiresAt) =>
      !DateTime.isGreaterThan(DateTime.subtractDuration(expiresAt, REFRESH_WINDOW), now),
    onNone: () =>
      Option.match(tokens.lastRefresh, {
        onNone: () => false,
        onSome: (last) =>
          !DateTime.isGreaterThan(DateTime.addDuration(last, REFRESH_INTERVAL), now),
      }),
  });

const usable = (state: LoginState, now: DateTime.Utc): boolean =>
  !state.refused && Option.isNone(state.rejected) && !refreshDue(state.tokens, now);

/** Whether `refreshToken` is this login's current refresh token or one it replaced. */
const holds = (state: LoginState, refreshToken: string): boolean =>
  Redacted.value(state.tokens.refreshToken) === refreshToken ||
  state.retired.includes(refreshToken);

const accessOf = ({ accessToken, accountId }: ChatGptTokens): ChatGptAccess => ({
  accessToken,
  accountId,
});

const expiryField = (tokens: ChatGptTokens) =>
  Option.match(tokens.expiresAt, { onNone: () => "unknown", onSome: DateTime.formatIso });

/**
 * The ChatGPT logins the Gateway holds, keyed by auth file. Each login's tokens stay in memory;
 * an access token is refreshed before it expires, one refresh at a time, and the rotated tokens
 * are written back to the auth file. A request never gets an access token that a failed
 * refresh should have replaced.
 */
export class ChatGptLogins extends Context.Service<
  ChatGptLogins,
  {
    /**
     * Returns the login's access token and account. Reads the auth file on first use, and
     * refreshes first if the token expires within five minutes or the upstream refused it.
     * Requests that need a refresh share one; it runs in the service's scope, so a request
     * that ends doesn't stop it between the token endpoint's rotation and the write-back.
     */
    readonly access: (login: ChatGptLogin) => Effect.Effect<ChatGptAccess, ChatGptLoginUnavailable>;
    /**
     * Records that the upstream refused `access` with 401, so the next request refreshes first,
     * unless this process refreshed it less than a minute ago.
     */
    readonly refused: (login: ChatGptLogin, access: ChatGptAccess) => Effect.Effect<void>;
    /**
     * Reads the login's auth file again. Keeps the tokens in memory if the file has their
     * refresh token or one they replaced, and otherwise uses the file's login.
     */
    readonly reload: (login: ChatGptLogin) => Effect.Effect<void, ChatGptAuthFileError>;
  }
>()("@usine/gateway/ChatGptLogins") {
  static readonly layer = Layer.effect(
    ChatGptLogins,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const client = yield* HttpClient.HttpClient;
      const scope = yield* Effect.scope;
      const states = yield* Ref.make<ReadonlyMap<string, LoginState>>(new Map());
      // Refreshes and reloads run one at a time, so a rotated refresh token is used once.
      const lock = yield* Semaphore.make(1);
      const inFlight = yield* SynchronizedRef.make<
        ReadonlyMap<string, Fiber.Fiber<ChatGptAccess, ChatGptLoginUnavailable>>
      >(new Map());

      const stateOf = (authFile: string) =>
        Effect.map(Ref.get(states), (all) => Option.fromNullishOr(all.get(authFile)));
      const store = (authFile: string, state: LoginState) =>
        Ref.update(states, (all) => new Map(all).set(authFile, state));

      const unavailable = (login: ChatGptLogin, reason: ChatGptLoginUnavailable["reason"]) => {
        switch (reason) {
          case "unreadable":
            return new ChatGptLoginUnavailable({
              authFile: login.authFile,
              reason,
              message: `The gateway can't read its ChatGPT login at ${login.authFile}. Its log has the reason.`,
            });
          case "refresh-failed":
            return new ChatGptLoginUnavailable({
              authFile: login.authFile,
              reason,
              message: `The gateway could not refresh its ChatGPT login and tries again after ${FAILURE_BACKOFF}. Its log has the reason.`,
            });
          case "refresh-rejected":
            return new ChatGptLoginUnavailable({
              authFile: login.authFile,
              reason,
              message: `The token endpoint rejected the refresh token of the gateway's ChatGPT login. Copy a new auth.json from codex login to ${login.authFile} and reload the gateway.`,
            });
        }
      };

      /** Returns the login's state, reading its auth file if it has none. */
      const loaded = Effect.fn("ChatGptLogins.loaded")(function* (login: ChatGptLogin) {
        const current = yield* stateOf(login.authFile);
        if (Option.isSome(current)) return current.value;
        const tokens = yield* readAuthFile(login.authFile).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.tapError((error) =>
            Effect.logError("Could not read the ChatGPT login", {
              authFile: login.authFile,
              error: error.message,
            }),
          ),
          Effect.mapError(() => unavailable(login, "unreadable")),
        );
        const state = fresh(tokens, []);
        yield* store(login.authFile, state);
        yield* Effect.logInfo("Loaded the ChatGPT login", {
          authFile: login.authFile,
          expiresAt: expiryField(tokens),
        });
        return state;
      });

      /** Records a refresh the token endpoint rejected, so later requests fail without calling it. */
      const rejectRefresh = Effect.fn("ChatGptLogins.rejectRefresh")(function* (
        login: ChatGptLogin,
        state: LoginState,
        status: number,
        code: Option.Option<string>,
      ) {
        const why = Option.getOrElse(code, () => `HTTP ${String(status)}`);
        yield* store(login.authFile, { ...state, rejected: Option.some(why) });
        yield* Effect.logError(
          "The token endpoint rejected the ChatGPT login's refresh token; copy a new auth.json from codex login and reload the gateway",
          { authFile: login.authFile, status, code: why },
        );
        return unavailable(login, "refresh-rejected");
      });

      /** Records a refresh that failed for another reason, so requests back off before the next one. */
      const failRefresh = Effect.fn("ChatGptLogins.failRefresh")(function* (
        login: ChatGptLogin,
        state: LoginState,
        error: string,
      ) {
        yield* store(login.authFile, { ...state, failedAt: Option.some(yield* DateTime.now) });
        yield* Effect.logError("Could not refresh the ChatGPT login; a later request tries again", {
          authFile: login.authFile,
          error,
          backoff: FAILURE_BACKOFF,
        });
        return unavailable(login, "refresh-failed");
      });

      /**
       * Exchanges the refresh token for new tokens and writes them back to the auth file. Runs
       * uninterruptibly: once the token endpoint has rotated the refresh token, only storing the
       * new one keeps the login usable.
       */
      const refresh = Effect.fn("ChatGptLogins.refresh")(function* (
        login: ChatGptLogin,
        state: LoginState,
      ) {
        yield* Effect.annotateCurrentSpan({ authFile: login.authFile });
        const request = HttpClientRequest.post(login.tokenUrl).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bodyJsonUnsafe({
            client_id: CODEX_CLIENT_ID,
            grant_type: "refresh_token",
            refresh_token: Redacted.value(state.tokens.refreshToken),
          }),
        );
        const answer = yield* client.execute(request).pipe(
          Effect.flatMap((response) =>
            Effect.map(response.text, (body) => ({ status: response.status, body })),
          ),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
          Effect.catchTag("HttpClientError", (error) =>
            Effect.flip(failRefresh(login, state, error.reason._tag)),
          ),
        );
        if (answer.status < 200 || answer.status >= 300) {
          const code = tokenErrorCode(answer.body);
          return yield* Effect.flip(
            isRejection(answer.status, code)
              ? rejectRefresh(login, state, answer.status, code)
              : failRefresh(
                  login,
                  state,
                  `the token endpoint answered ${String(answer.status)} (${Option.getOrElse(code, () => "no error code")})`,
                ),
          );
        }
        const body = decodeRefreshResponse(answer.body);
        const accessToken = Option.flatMap(body, ({ access_token }) => present(access_token));
        if (Option.isNone(body) || Option.isNone(accessToken))
          return yield* Effect.flip(
            failRefresh(login, state, "the token endpoint's answer has no access_token"),
          );
        const refreshToken = present(body.value.refresh_token);
        const idToken = present(body.value.id_token);
        const now = yield* DateTime.now;
        const tokens = new ChatGptTokens({
          accessToken: Redacted.make(accessToken.value),
          refreshToken: Option.match(refreshToken, {
            onNone: () => state.tokens.refreshToken,
            onSome: Redacted.make,
          }),
          accountId: state.tokens.accountId.pipe(
            Option.orElse(() => Option.flatMap(idToken, idTokenAccount)),
          ),
          expiresAt: jwtExpiry(accessToken.value),
          lastRefresh: Option.some(now),
        });
        const retired = Option.isSome(refreshToken)
          ? [Redacted.value(state.tokens.refreshToken), ...state.retired].slice(0, RETIRED_TOKENS)
          : state.retired;
        yield* store(login.authFile, {
          ...fresh(tokens, retired),
          refreshedAt: Option.some(now),
        });
        yield* Effect.logInfo("Refreshed the ChatGPT login", {
          authFile: login.authFile,
          expiresAt: expiryField(tokens),
          rotated: Option.isSome(refreshToken),
        });
        yield* writeAuthFile(login.authFile, tokens, idToken, (inFile) =>
          holds(state, inFile),
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.flatMap((written) =>
            written
              ? Effect.logInfo("Wrote the refreshed ChatGPT login to its auth file", {
                  authFile: login.authFile,
                })
              : Effect.logWarning(
                  "Left the auth file as it is: it holds another ChatGPT login, which the next reload reads",
                  { authFile: login.authFile },
                ),
          ),
          Effect.catchTag("ChatGptAuthFileError", (error) =>
            Effect.logError(
              "Could not write the refreshed ChatGPT login to its auth file; the gateway keeps it in memory, and after a restart the file's refresh token may no longer work",
              { authFile: login.authFile, error: error.message },
            ),
          ),
        );
        return tokens;
      }, Effect.uninterruptible);

      /** Returns a usable access token, refreshing first if needed. Runs under the lock. */
      const refreshed = Effect.fn("ChatGptLogins.refreshed")(function* (login: ChatGptLogin) {
        const state = yield* loaded(login);
        if (Option.isSome(state.rejected)) return yield* unavailable(login, "refresh-rejected");
        const now = yield* DateTime.now;
        if (usable(state, now)) return accessOf(state.tokens);
        if (within(state.failedAt, FAILURE_BACKOFF, now))
          return yield* unavailable(login, "refresh-failed");
        yield* Effect.logInfo("Refreshing the ChatGPT login", {
          authFile: login.authFile,
          reason: state.refused ? "refused-by-upstream" : "expiring",
          expiresAt: expiryField(state.tokens),
        });
        return accessOf(yield* refresh(login, state));
      });

      /** Returns the login's refresh in progress, or starts one in the service's scope. */
      const refreshing = (login: ChatGptLogin) =>
        SynchronizedRef.modifyEffect(inFlight, (all) => {
          const running = all.get(login.authFile);
          if (running !== undefined) return Effect.succeed([running, all] as const);
          return lock
            .withPermits(1)(refreshed(login))
            .pipe(
              Effect.ensuring(
                SynchronizedRef.update(inFlight, (now) => {
                  const next = new Map(now);
                  next.delete(login.authFile);
                  return next;
                }),
              ),
              Effect.forkIn(scope),
              Effect.map((fiber) => [fiber, new Map(all).set(login.authFile, fiber)] as const),
            );
        });

      const access = Effect.fn("ChatGptLogins.access")(function* (login: ChatGptLogin) {
        yield* Effect.annotateCurrentSpan({ authFile: login.authFile });
        const current = yield* stateOf(login.authFile);
        if (Option.isSome(current) && usable(current.value, yield* DateTime.now))
          return accessOf(current.value.tokens);
        return yield* Fiber.join(yield* refreshing(login));
      });

      const refused = Effect.fn("ChatGptLogins.refused")(function* (
        login: ChatGptLogin,
        presented: ChatGptAccess,
      ) {
        yield* Effect.annotateCurrentSpan({ authFile: login.authFile });
        const now = yield* DateTime.now;
        // Marks the state in one update, so a refresh that ends meanwhile isn't overwritten.
        const outcome = yield* Ref.modify(
          states,
          (all): readonly ["replaced" | "recent" | "marked", ReadonlyMap<string, LoginState>] => {
            const current = all.get(login.authFile);
            if (
              current === undefined ||
              Redacted.value(current.tokens.accessToken) !== Redacted.value(presented.accessToken)
            )
              return ["replaced", all];
            if (within(current.refreshedAt, REFUSAL_GRACE, now)) return ["recent", all];
            return ["marked", new Map(all).set(login.authFile, { ...current, refused: true })];
          },
        );
        switch (outcome) {
          case "replaced":
            return yield* Effect.logDebug(
              "The ChatGPT backend refused an access token the gateway already replaced",
              { authFile: login.authFile },
            );
          case "recent":
            return yield* Effect.logWarning(
              "The ChatGPT backend refused an access token refreshed less than a minute ago; the gateway doesn't refresh it again yet",
              { authFile: login.authFile },
            );
          case "marked":
            return yield* Effect.logWarning(
              "The ChatGPT backend refused the gateway's access token; the next request refreshes it first",
              { authFile: login.authFile },
            );
        }
      });

      const reload = Effect.fn("ChatGptLogins.reload")(function* (login: ChatGptLogin) {
        yield* Effect.annotateCurrentSpan({ authFile: login.authFile });
        const tokens = yield* readAuthFile(login.authFile).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
        );
        const all = yield* Ref.get(states);
        const read = Redacted.value(tokens.refreshToken);
        // Any login that holds the file's refresh token, also under another path, already used or rotated it.
        const holder = Option.fromNullishOr(all.get(login.authFile)).pipe(
          Option.filter((state) => holds(state, read)),
          Option.orElse(() =>
            Option.fromNullishOr([...all.values()].find((state) => holds(state, read))),
          ),
        );
        if (Option.isSome(holder)) {
          yield* store(login.authFile, holder.value);
          return yield* Effect.logInfo("Kept the ChatGPT login: its auth file has the same login", {
            authFile: login.authFile,
            rejected: Option.isSome(holder.value.rejected),
          });
        }
        yield* store(login.authFile, fresh(tokens, []));
        yield* Effect.logInfo("Loaded the ChatGPT login", {
          authFile: login.authFile,
          expiresAt: expiryField(tokens),
          replaced: all.has(login.authFile),
        });
      }, lock.withPermits(1));

      return { access, refused, reload };
    }),
  );
}
