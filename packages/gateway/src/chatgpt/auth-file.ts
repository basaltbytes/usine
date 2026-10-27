import { DateTime, Effect, Exit, FileSystem, Option, Redacted, Result, Schema } from "effect";
import { Base64Url } from "effect/encoding";

/**
 * The error when a ChatGPT login's `auth.json` can't be read or written, or isn't a Codex
 * ChatGPT login. The message never contains a token.
 */
export class ChatGptAuthFileError extends Schema.TaggedError<ChatGptAuthFileError>()(
  "ChatGptAuthFileError",
  {
    path: Schema.String,
    operation: Schema.Literals(["read", "write"]),
    message: Schema.String,
  },
) {}

const Token = Schema.Redacted(Schema.NonEmptyString);

/** A ChatGPT login's tokens as the Gateway holds them in memory. */
export class ChatGptTokens extends Schema.Class<ChatGptTokens>("@usine/gateway/ChatGptTokens")({
  accessToken: Token,
  refreshToken: Token,
  /** The ChatGPT account or workspace ID, sent as `ChatGPT-Account-ID`. */
  accountId: Schema.Option(Schema.NonEmptyString),
  /** The access token's `exp` claim, if it has one. */
  expiresAt: Schema.Option(Schema.DateTimeUtc),
  /** When the tokens were last refreshed, from `last_refresh`. */
  lastRefresh: Schema.Option(Schema.DateTimeUtc),
}) {}

const JsonObject = Schema.Record(Schema.String, Schema.Json);
const decodeJsonObject = Schema.decodeUnknownOption(JsonObject);
const decodeAuthFileObject = Schema.decodeUnknownOption(Schema.fromJsonString(JsonObject));

/** The fields of Codex's `auth.json` that the Gateway reads; the others are kept as they are. */
const AuthFileFields = Schema.Struct({
  tokens: Schema.Struct({
    access_token: Schema.NonEmptyString,
    refresh_token: Schema.NonEmptyString,
    id_token: Schema.optionalKey(Schema.NullOr(Schema.String)),
    account_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
  last_refresh: Schema.optionalKey(Schema.NullOr(Schema.DateTimeUtcFromString)),
});
const decodeAuthFileFields = Schema.decodeUnknownOption(AuthFileFields);

const JwtClaims = Schema.fromJsonString(
  Schema.Struct({
    exp: Schema.optionalKey(Schema.Number),
    "https://api.openai.com/auth": Schema.optionalKey(
      Schema.Struct({ chatgpt_account_id: Schema.optionalKey(Schema.String) }),
    ),
  }),
);
const decodeJwtClaims = Schema.decodeUnknownOption(JwtClaims);

/** Returns a JWT's claims without checking its signature, which only the issuer can. */
const jwtClaims = (jwt: string) =>
  Option.fromNullishOr(jwt.split(".")[1]).pipe(
    Option.flatMap((payload) => Result.getSuccess(Base64Url.decodeString(payload))),
    Option.flatMap(decodeJwtClaims),
  );

/** Returns the expiry in a JWT's `exp` claim, in seconds since the epoch. */
export const jwtExpiry = (jwt: string): Option.Option<DateTime.Utc> =>
  jwtClaims(jwt).pipe(
    Option.flatMap(({ exp }) => Option.fromNullishOr(exp)),
    Option.flatMap((seconds) => DateTime.make(seconds * 1000)),
  );

/** Returns the ChatGPT account ID in an ID token's claims. */
export const idTokenAccount = (idToken: string): Option.Option<string> =>
  jwtClaims(idToken).pipe(
    Option.flatMap((claims) =>
      Option.fromNullishOr(claims["https://api.openai.com/auth"]?.chatgpt_account_id),
    ),
    Option.filter((account) => account !== ""),
  );

const nonEmpty = (value: string | null | undefined) =>
  Option.fromNullishOr(value).pipe(Option.filter((text) => text !== ""));

/** Returns the tokens in the text of a Codex `auth.json`. */
const tokensFromAuthFile = (
  path: string,
  text: string,
): Result.Result<ChatGptTokens, ChatGptAuthFileError> => {
  const fields = decodeAuthFileObject(text).pipe(Option.flatMap(decodeAuthFileFields));
  if (Option.isNone(fields))
    return Result.fail(
      new ChatGptAuthFileError({
        path,
        operation: "read",
        message: `${path} isn't a Codex ChatGPT login: it needs tokens.access_token and tokens.refresh_token, as codex login writes them.`,
      }),
    );
  const { tokens, last_refresh } = fields.value;
  return Result.succeed(
    new ChatGptTokens({
      accessToken: Redacted.make(tokens.access_token),
      refreshToken: Redacted.make(tokens.refresh_token),
      accountId: nonEmpty(tokens.account_id).pipe(
        Option.orElse(() => nonEmpty(tokens.id_token).pipe(Option.flatMap(idTokenAccount))),
      ),
      expiresAt: jwtExpiry(tokens.access_token),
      lastRefresh: Option.fromNullishOr(last_refresh),
    }),
  );
};

/** Reads and parses the Codex `auth.json` at `path`. */
export const readAuthFile = Effect.fn("ChatGptAuthFile.read")(function* (path: string) {
  yield* Effect.annotateCurrentSpan({ authFile: path });
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(path)
    .pipe(
      Effect.mapError(
        (error) => new ChatGptAuthFileError({ path, operation: "read", message: error.message }),
      ),
    );
  return yield* Effect.fromResult(tokensFromAuthFile(path, text));
});

/** Returns the path of a new temporary file next to `path`. */
const besides = (path: string, suffix: string) => `${path}.${crypto.randomUUID()}.${suffix}`;

/**
 * Writes rotated tokens into the Codex `auth.json` at `path` and sets `last_refresh`, keeping
 * its other fields. Writes a temporary file with mode 0600 next to it and renames it over the
 * file, so a reader sees either file whole, and removes the temporary file if that fails or is
 * interrupted. Returns `false`, writing nothing, if the file's refresh token isn't one `owns`
 * accepts, such as a login the operator copied in that the next reload reads.
 */
export const writeAuthFile = Effect.fn("ChatGptAuthFile.write")(function* (
  path: string,
  tokens: ChatGptTokens,
  idToken: Option.Option<string>,
  owns: (refreshToken: string) => boolean,
) {
  yield* Effect.annotateCurrentSpan({ authFile: path });
  const fs = yield* FileSystem.FileSystem;
  const failed = (message: string) =>
    new ChatGptAuthFileError({ path, operation: "write", message });
  const text = yield* fs
    .readFileString(path)
    .pipe(Effect.mapError((error) => failed(error.message)));
  const current = yield* Effect.fromOption(decodeAuthFileObject(text)).pipe(
    Effect.mapError(() => failed(`${path} is no longer a JSON object, so it wasn't replaced.`)),
  );
  const inFile = decodeAuthFileFields(current).pipe(
    Option.map(({ tokens: held }) => held.refresh_token),
  );
  if (!Option.exists(inFile, owns)) return false;
  const previousTokens = Option.getOrElse(decodeJsonObject(current.tokens), () => ({}));
  const next = {
    ...current,
    tokens: {
      ...previousTokens,
      access_token: Redacted.value(tokens.accessToken),
      refresh_token: Redacted.value(tokens.refreshToken),
      ...Option.match(idToken, { onNone: () => ({}), onSome: (id_token) => ({ id_token }) }),
    },
    last_refresh: Option.match(tokens.lastRefresh, {
      onNone: () => current.last_refresh ?? null,
      onSome: DateTime.formatIso,
    }),
  };
  const temporary = besides(path, "tmp");
  yield* fs.writeFileString(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 }).pipe(
    Effect.andThen(fs.rename(temporary, path)),
    Effect.onExit((exit) =>
      Exit.isSuccess(exit) ? Effect.void : fs.remove(temporary).pipe(Effect.ignore),
    ),
    Effect.mapError((error) => failed(error.message)),
  );
  return true;
});

/**
 * Checks that the Gateway can write the rotated tokens next to the auth file at `path`, by
 * creating and removing a file there, so a missing write permission shows before the first
 * refresh.
 */
export const checkAuthFileWritable = Effect.fn("ChatGptAuthFile.checkWritable")(function* (
  path: string,
) {
  yield* Effect.annotateCurrentSpan({ authFile: path });
  const fs = yield* FileSystem.FileSystem;
  const probe = besides(path, "check");
  yield* fs.writeFileString(probe, "", { mode: 0o600 }).pipe(
    Effect.andThen(fs.remove(probe)),
    Effect.mapError(
      (error) =>
        new ChatGptAuthFileError({
          path,
          operation: "write",
          message: `The gateway can't write next to ${path}, so it couldn't save a refreshed login: ${error.message}`,
        }),
    ),
  );
});
