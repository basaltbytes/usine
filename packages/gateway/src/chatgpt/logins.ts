import {
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Ref,
  Schema,
  Semaphore,
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

const REFRESH_TIMEOUT = "30 seconds";

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
 * be read (`unreadable`), the last refresh failed and is retried on the next request
 * (`refresh-failed`), or the token endpoint rejected the refresh token, which only a new login
 * fixes (`refresh-rejected`). The reverse proxy answers it with 401.
 */
export class ChatGptLoginUnavailable extends Schema.TaggedError<ChatGptLoginUnavailable>()(
  "ChatGptLoginUnavailable",
  {
    authFile: Schema.String,
    reason: Schema.Literals(["unreadable", "refresh-failed", "refresh-rejected"]),
    message: Schema.String,
  },
) {}

const RefreshResponse = Schema.fromJsonString(
  Schema.Struct({
    access_token: Schema.optionalKey(Schema.NonEmptyString),
    refresh_token: Schema.optionalKey(Schema.NonEmptyString),
    id_token: Schema.optionalKey(Schema.NonEmptyString),
  }),
);
const decodeRefreshResponse = Schema.decodeUnknownOption(RefreshResponse);

const decodeErrorText = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ error: Schema.NonEmptyString })),
);
const decodeErrorObject = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ error: Schema.Struct({ code: Schema.NonEmptyString }) })),
);
const decodeErrorCode = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ code: Schema.NonEmptyString })),
);

/** Returns the error code in a token endpoint's error body, in lowercase: `error`, `error.code`, or `code`, as Codex reads it. */
const tokenErrorCode = (body: string): Option.Option<string> =>
  decodeErrorText(body).pipe(
    Option.map(({ error }) => error),
    Option.orElse(() => Option.map(decodeErrorObject(body), ({ error }) => error.code)),
    Option.orElse(() => Option.map(decodeErrorCode(body), ({ code }) => code)),
    Option.map((code) => code.toLowerCase()),
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
}

const fresh = (tokens: ChatGptTokens, retired: ReadonlyArray<string>): LoginState => ({
  tokens,
  refused: false,
  rejected: Option.none(),
  retired,
});

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
     */
    readonly access: (login: ChatGptLogin) => Effect.Effect<ChatGptAccess, ChatGptLoginUnavailable>;
    /** Records that the upstream refused `access` with 401, so the next request refreshes first. */
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
      const states = yield* Ref.make<ReadonlyMap<string, LoginState>>(new Map());
      // Refreshes and reloads run one at a time, so a rotated refresh token is used once.
      const lock = yield* Semaphore.make(1);

      const stateOf = (authFile: string) =>
        Effect.map(Ref.get(states), (all) => Option.fromNullishOr(all.get(authFile)));
      const store = (authFile: string, state: LoginState) =>
        Ref.update(states, (all) => new Map(all).set(authFile, state));

      const unavailable = (
        login: ChatGptLogin,
        reason: ChatGptLoginUnavailable["reason"],
        message: string,
      ) => new ChatGptLoginUnavailable({ authFile: login.authFile, reason, message });

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
          Effect.mapError((error) => unavailable(login, "unreadable", error.message)),
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
        return unavailable(
          login,
          "refresh-rejected",
          `The token endpoint rejected the refresh token of the gateway's ChatGPT login (${why}). Copy a new auth.json from codex login to ${login.authFile} and reload the gateway.`,
        );
      });

      const refreshFailed = (login: ChatGptLogin, error: string) =>
        Effect.logError("Could not refresh the ChatGPT login; the next request tries again", {
          authFile: login.authFile,
          error,
        }).pipe(
          Effect.as(
            unavailable(
              login,
              "refresh-failed",
              `The gateway could not refresh its ChatGPT login: ${error}. The next request tries again.`,
            ),
          ),
        );

      /** Exchanges the refresh token for new tokens and writes them back to the auth file. */
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
          Effect.timeout(REFRESH_TIMEOUT),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
          Effect.catchTags({
            HttpClientError: (error) => Effect.flip(refreshFailed(login, error.reason._tag)),
            TimeoutError: () =>
              Effect.flip(refreshFailed(login, `no answer in ${REFRESH_TIMEOUT}`)),
          }),
        );
        if (answer.status < 200 || answer.status >= 300) {
          const code = tokenErrorCode(answer.body);
          return yield* isRejection(answer.status, code)
            ? Effect.flip(rejectRefresh(login, state, answer.status, code))
            : Effect.flip(
                refreshFailed(
                  login,
                  `the token endpoint answered ${String(answer.status)}${Option.match(code, { onNone: () => "", onSome: (value) => ` (${value})` })}`,
                ),
              );
        }
        const body = decodeRefreshResponse(answer.body);
        const accessToken = Option.flatMap(body, ({ access_token }) =>
          Option.fromNullishOr(access_token),
        );
        if (Option.isNone(body) || Option.isNone(accessToken))
          return yield* Effect.flip(
            refreshFailed(login, "the token endpoint's answer has no access_token"),
          );
        const { refresh_token, id_token } = body.value;
        const tokens = new ChatGptTokens({
          accessToken: Redacted.make(accessToken.value),
          refreshToken: Option.match(Option.fromNullishOr(refresh_token), {
            onNone: () => state.tokens.refreshToken,
            onSome: Redacted.make,
          }),
          accountId: state.tokens.accountId.pipe(
            Option.orElse(() => Option.flatMap(Option.fromNullishOr(id_token), idTokenAccount)),
          ),
          expiresAt: jwtExpiry(accessToken.value),
          lastRefresh: Option.some(yield* DateTime.now),
        });
        const rotated = refresh_token !== undefined;
        const retired = rotated
          ? [Redacted.value(state.tokens.refreshToken), ...state.retired].slice(0, RETIRED_TOKENS)
          : state.retired;
        yield* store(login.authFile, fresh(tokens, retired));
        yield* Effect.logInfo("Refreshed the ChatGPT login", {
          authFile: login.authFile,
          expiresAt: expiryField(tokens),
          rotated,
        });
        yield* writeAuthFile(login.authFile, tokens, Option.fromNullishOr(id_token)).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.andThen(
            Effect.logInfo("Wrote the refreshed ChatGPT login to its auth file", {
              authFile: login.authFile,
            }),
          ),
          Effect.catchTag("ChatGptAuthFileError", (error) =>
            Effect.logError(
              "Could not write the refreshed ChatGPT login to its auth file; the gateway keeps it in memory, and after a restart the file's refresh token may no longer work",
              { authFile: login.authFile, error: error.message },
            ),
          ),
        );
        return tokens;
      });

      /** Returns a usable access token, refreshing first if needed. Runs under the lock. */
      const refreshed = Effect.fn("ChatGptLogins.refreshed")(function* (login: ChatGptLogin) {
        const state = yield* loaded(login);
        if (Option.isSome(state.rejected))
          return yield* unavailable(
            login,
            "refresh-rejected",
            `The token endpoint rejected the refresh token of the gateway's ChatGPT login (${state.rejected.value}). Copy a new auth.json from codex login to ${login.authFile} and reload the gateway.`,
          );
        if (usable(state, yield* DateTime.now)) return accessOf(state.tokens);
        yield* Effect.logInfo("Refreshing the ChatGPT login", {
          authFile: login.authFile,
          reason: state.refused ? "refused-by-upstream" : "expiring",
          expiresAt: expiryField(state.tokens),
        });
        return accessOf(yield* refresh(login, state));
      });

      const access = Effect.fn("ChatGptLogins.access")(function* (login: ChatGptLogin) {
        yield* Effect.annotateCurrentSpan({ authFile: login.authFile });
        const current = yield* stateOf(login.authFile);
        if (Option.isSome(current) && usable(current.value, yield* DateTime.now))
          return accessOf(current.value.tokens);
        return yield* lock.withPermits(1)(refreshed(login));
      });

      const refused = Effect.fn("ChatGptLogins.refused")(function* (
        login: ChatGptLogin,
        presented: ChatGptAccess,
      ) {
        yield* Effect.annotateCurrentSpan({ authFile: login.authFile });
        // Marks the state in one update, so a refresh that ends meanwhile isn't overwritten.
        const marked = yield* Ref.modify(states, (all) => {
          const current = all.get(login.authFile);
          return current === undefined ||
            Redacted.value(current.tokens.accessToken) !== Redacted.value(presented.accessToken)
            ? [false, all]
            : [true, new Map(all).set(login.authFile, { ...current, refused: true })];
        });
        if (!marked)
          return yield* Effect.logDebug(
            "The ChatGPT backend refused an access token the gateway already replaced",
            { authFile: login.authFile },
          );
        yield* Effect.logWarning(
          "The ChatGPT backend refused the gateway's access token; the next request refreshes it first",
          { authFile: login.authFile },
        );
      });

      const reload = Effect.fn("ChatGptLogins.reload")(function* (login: ChatGptLogin) {
        yield* Effect.annotateCurrentSpan({ authFile: login.authFile });
        const tokens = yield* readAuthFile(login.authFile).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
        );
        const current = yield* stateOf(login.authFile);
        const read = Redacted.value(tokens.refreshToken);
        const same = Option.exists(
          current,
          (state) =>
            Redacted.value(state.tokens.refreshToken) === read || state.retired.includes(read),
        );
        if (Option.isSome(current) && same)
          return yield* Effect.logInfo("Kept the ChatGPT login: its auth file has the same login", {
            authFile: login.authFile,
            rejected: Option.isSome(current.value.rejected),
          });
        yield* store(login.authFile, fresh(tokens, []));
        yield* Effect.logInfo("Loaded the ChatGPT login", {
          authFile: login.authFile,
          expiresAt: expiryField(tokens),
          replaced: Option.isSome(current),
        });
      }, lock.withPermits(1));

      return { access, refused, reload };
    }),
  );
}
