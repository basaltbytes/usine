import { RepositoryName } from "@usine/core/repository";
import { WorkerName } from "@usine/core/worker";
import { Context, Effect, Layer, Option, Redacted, Result, Schema } from "effect";
import { Base64, Base64Url } from "effect/encoding";
import { Headers } from "effect/http";
import { AttachmentId } from "../attachment/attachment.ts";
import { GatewaySettings } from "../settings.ts";

/**
 * The attachment ID, worker, and repository signed into a caller token. The proxy checks these
 * claims against an active attachment; a new attachment cannot reactivate an old token.
 */
export class CallerClaims extends Schema.Class<CallerClaims>("@usine/gateway/CallerClaims")({
  /** The attachment ID whose validity the proxy checks after signature verification. */
  attachment: AttachmentId,
  /** The worker authorized by the attachment. */
  worker: WorkerName,
  /** The repository authorized by the attachment, in owner/name form. */
  repository: RepositoryName,
}) {}

/**
 * The token a worker VM sends instead of a real credential. It's issued with each attachment
 * and accepted only while that attachment is active.
 */
export const CallerToken = Schema.Redacted(Schema.NonEmptyString);
export type CallerToken = typeof CallerToken.Type;

/**
 * The error for a caller token the gateway didn't issue: `malformed` if the format is wrong,
 * `bad-signature` if it wasn't signed with the gateway's key.
 */
export class CallerTokenRejected extends Schema.TaggedError<CallerTokenRejected>()(
  "CallerTokenRejected",
  {
    /** Whether decoding failed or the signature did not match the gateway caller key. */
    reason: Schema.Literals(["malformed", "bad-signature"]),
  },
) {}

/** The header for tools that can add one, such as git with `http.extraHeader`. */
export const GATEWAY_TOKEN_HEADER = "x-usine-gateway-token";

/** The headers that can contain a caller credential; all are removed before forwarding. */
const CALLER_CREDENTIAL_HEADERS = [
  GATEWAY_TOKEN_HEADER,
  "authorization",
  "x-api-key",
  "proxy-authorization",
] as const;

const TOKEN_FORMAT = /^ugw1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/u;

const encoder = new TextEncoder();

const toArrayBuffer = (value: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(value.byteLength);
  new Uint8Array(buffer).set(value);
  return buffer;
};

const ClaimsJson = Schema.fromJsonString(CallerClaims);
const encodeClaims = Schema.encodeSync(ClaimsJson);
const decodeClaims = Schema.decodeUnknownOption(ClaimsJson);

/**
 * Issues and verifies caller tokens of the form `ugw1.<claims>.<HMAC-SHA256>` under the
 * gateway's caller key. The same attachment always yields the same token, so no token table
 * is kept.
 */
export class CallerTokens extends Context.Service<
  CallerTokens,
  {
    /**
     * Signs `claims` with the configured caller key. Identical claims produce the same token; this
     * does not register an attachment.
     */
    readonly issue: (claims: CallerClaims) => Effect.Effect<CallerToken>;
    /**
     * Checks the format and signature of `token` and returns its claims. Callers must separately
     * check that the attachment is active and matches the claims.
     */
    readonly verify: (token: CallerToken) => Effect.Effect<CallerClaims, CallerTokenRejected>;
    /**
     * Removes caller tokens from headers for a host outside the gateway: always the gateway
     * header, and `Authorization` or `x-api-key` only if the value verifies as a caller token.
     */
    readonly withoutCallerTokens: (headers: Headers.Headers) => Effect.Effect<Headers.Headers>;
  }
>()("@usine/gateway/CallerTokens") {
  /** Imports the caller key from `GatewaySettings` for signing and verification with Web Crypto. */
  static readonly layer = Layer.effect(
    CallerTokens,
    Effect.gen(function* () {
      const { callerKey } = yield* GatewaySettings;
      const key = yield* Effect.promise(() =>
        crypto.subtle.importKey(
          "raw",
          toArrayBuffer(encoder.encode(Redacted.value(callerKey))),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign", "verify"],
        ),
      );

      const issue = Effect.fn("CallerTokens.issue")(function* (claims: CallerClaims) {
        yield* Effect.annotateCurrentSpan({
          attachment: claims.attachment,
          worker: claims.worker,
          repository: claims.repository,
        });
        const signed = `ugw1.${Base64Url.encode(encodeClaims(claims))}`;
        const mac = yield* Effect.promise(() =>
          crypto.subtle.sign("HMAC", key, toArrayBuffer(encoder.encode(signed))),
        );
        return Redacted.make(`${signed}.${Base64Url.encode(new Uint8Array(mac))}`);
      });

      const verify = Effect.fn("CallerTokens.verify")(function* (token: CallerToken) {
        const match = TOKEN_FORMAT.exec(Redacted.value(token));
        const payload = match?.[1];
        const mac = Option.fromNullishOr(match?.[2]).pipe(
          Option.flatMap((value) => Result.getSuccess(Base64Url.decode(value))),
        );
        if (payload === undefined || Option.isNone(mac))
          return yield* new CallerTokenRejected({ reason: "malformed" });
        const authentic = yield* Effect.promise(() =>
          crypto.subtle.verify(
            "HMAC",
            key,
            toArrayBuffer(mac.value),
            toArrayBuffer(encoder.encode(`ugw1.${payload}`)),
          ),
        );
        if (!authentic) return yield* new CallerTokenRejected({ reason: "bad-signature" });
        const claims = Result.getSuccess(Base64Url.decodeString(payload)).pipe(
          Option.flatMap(decodeClaims),
        );
        if (Option.isNone(claims)) return yield* new CallerTokenRejected({ reason: "malformed" });
        yield* Effect.annotateCurrentSpan({
          attachment: claims.value.attachment,
          worker: claims.value.worker,
          repository: claims.value.repository,
        });
        return claims.value;
      });

      const isCallerToken = (token: Option.Option<CallerToken>) =>
        Option.match(token, {
          onNone: () => Effect.succeed(false),
          onSome: (candidate) =>
            verify(candidate).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            ),
        });

      const withoutCallerTokens = Effect.fn("CallerTokens.withoutCallerTokens")(function* (
        headers: Headers.Headers,
      ) {
        const remaining = Headers.remove(headers, GATEWAY_TOKEN_HEADER);
        const authorization = Headers.get(remaining, "authorization").pipe(
          Option.flatMap(tokenFromAuthorization),
        );
        const apiKey = Headers.get(remaining, "x-api-key").pipe(
          Option.map((value) => Redacted.make(value.trim())),
        );
        const withoutAuthorization = (yield* isCallerToken(authorization))
          ? Headers.remove(remaining, "authorization")
          : remaining;
        return (yield* isCallerToken(apiKey))
          ? Headers.remove(withoutAuthorization, "x-api-key")
          : withoutAuthorization;
      });

      return { issue, verify, withoutCallerTokens };
    }),
  );
}

/**
 * Returns the credential in an `Authorization` or `Proxy-Authorization` value: the `Bearer` or
 * `token` parameter, or the `Basic` password (the user name if the password is empty).
 * Returns `None` for an unsupported scheme or an unusable credential. Does not verify the token.
 */
export const tokenFromAuthorization = (value: string): Option.Option<CallerToken> => {
  const match = /^(\S+)\s+(\S+)\s*$/u.exec(value.trim());
  const scheme = match?.[1]?.toLowerCase();
  const parameter = match?.[2];
  if (scheme === undefined || parameter === undefined) return Option.none();
  if (scheme === "bearer" || scheme === "token") return Option.some(Redacted.make(parameter));
  if (scheme !== "basic") return Option.none();
  return Result.getSuccess(Base64.decodeString(parameter)).pipe(
    Option.flatMap((pair) => {
      const separator = pair.indexOf(":");
      const user = separator === -1 ? pair : pair.slice(0, separator);
      const password = separator === -1 ? "" : pair.slice(separator + 1);
      const secret = password === "" ? user : password;
      return secret === "" ? Option.none() : Option.some(Redacted.make(secret));
    }),
  );
};

/**
 * Returns the caller token from the request headers, checking the gateway header, then
 * `Authorization` (gh, Codex, git, and Claude Code with `ANTHROPIC_AUTH_TOKEN` or
 * `CLAUDE_CODE_OAUTH_TOKEN`), then `x-api-key` (Claude Code with `ANTHROPIC_API_KEY`).
 */
export const presentedToken = (headers: Headers.Headers): Option.Option<CallerToken> =>
  Headers.get(headers, GATEWAY_TOKEN_HEADER).pipe(
    Option.filter((value) => value.trim() !== ""),
    Option.map((value) => Redacted.make(value.trim())),
    Option.orElse(() =>
      Headers.get(headers, "authorization").pipe(Option.flatMap(tokenFromAuthorization)),
    ),
    Option.orElse(() =>
      Headers.get(headers, "x-api-key").pipe(
        Option.filter((value) => value.trim() !== ""),
        Option.map((value) => Redacted.make(value.trim())),
      ),
    ),
  );

/** Returns `headers` without any header that can contain a caller credential. */
export const withoutCallerCredentials = (headers: Headers.Headers): Headers.Headers =>
  CALLER_CREDENTIAL_HEADERS.reduce((remaining, name) => Headers.remove(remaining, name), headers);
