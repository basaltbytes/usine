import { RepositoryName } from "@usine/core/repository";
import { WorkerName } from "@usine/core/worker";
import { Context, Effect, Encoding, Layer, Option, Redacted, Result, Schema } from "effect";
import { Headers } from "effect/unstable/http";
import { GatewaySettings } from "../settings.ts";

/** What a caller token proves: the Worker VM that has it and the repository it was issued for. */
export class CallerClaims extends Schema.Class<CallerClaims>("@usine/gateway/CallerClaims")({
  worker: WorkerName,
  repository: RepositoryName,
}) {}

/**
 * The credential a Worker VM sends in place of a real one. The gateway
 * issues it with each attachment and honors it only while that attachment is
 * in force, so it grants nothing the executor did not attach.
 */
export const CallerToken = Schema.Redacted(Schema.NonEmptyString);
export type CallerToken = typeof CallerToken.Type;

/** A presented caller token that the gateway did not issue: `malformed` is not in its format, `bad-signature` was not signed with its key. */
export class CallerTokenRejected extends Schema.TaggedError<CallerTokenRejected>()(
  "CallerTokenRejected",
  { reason: Schema.Literals(["malformed", "bad-signature"]) },
) {}

/** The header a caller sets when its tool can add one, such as git with `http.extraHeader`. */
export const GATEWAY_TOKEN_HEADER = "x-usine-gateway-token";

/** Every header that can carry a caller's credential. The gateway removes all of them before it forwards a request. */
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
 * Issues and checks caller tokens. A token is `ugw1.<claims>.<HMAC-SHA256>`
 * under the gateway's caller key, so the same attachment yields the same
 * token after a gateway restart or a renewal, and the gateway keeps no token
 * table.
 */
export class CallerTokens extends Context.Service<
  CallerTokens,
  {
    readonly issue: (claims: CallerClaims) => Effect.Effect<CallerToken>;
    readonly verify: (token: CallerToken) => Effect.Effect<CallerClaims, CallerTokenRejected>;
  }
>()("@usine/gateway/CallerTokens") {
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
        yield* Effect.annotateCurrentSpan({ worker: claims.worker, repository: claims.repository });
        const signed = `ugw1.${Encoding.encodeBase64Url(encodeClaims(claims))}`;
        const mac = yield* Effect.promise(() =>
          crypto.subtle.sign("HMAC", key, toArrayBuffer(encoder.encode(signed))),
        );
        return Redacted.make(`${signed}.${Encoding.encodeBase64Url(new Uint8Array(mac))}`);
      });

      const verify = Effect.fn("CallerTokens.verify")(function* (token: CallerToken) {
        const match = TOKEN_FORMAT.exec(Redacted.value(token));
        const payload = match?.[1];
        const mac = Option.fromNullishOr(match?.[2]).pipe(
          Option.flatMap((value) => Result.getSuccess(Encoding.decodeBase64Url(value))),
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
        const claims = Result.getSuccess(Encoding.decodeBase64UrlString(payload)).pipe(
          Option.flatMap(decodeClaims),
        );
        if (Option.isNone(claims)) return yield* new CallerTokenRejected({ reason: "malformed" });
        yield* Effect.annotateCurrentSpan({
          worker: claims.value.worker,
          repository: claims.value.repository,
        });
        return claims.value;
      });

      return { issue, verify };
    }),
  );
}

/**
 * The credential in an `Authorization` or `Proxy-Authorization` value: the
 * parameter of `Bearer` and `token`, or the password of `Basic` (the user
 * name when the password is empty).
 */
export const tokenFromAuthorization = (value: string): Option.Option<CallerToken> => {
  const match = /^(\S+)\s+(\S+)\s*$/u.exec(value.trim());
  const scheme = match?.[1]?.toLowerCase();
  const parameter = match?.[2];
  if (scheme === undefined || parameter === undefined) return Option.none();
  if (scheme === "bearer" || scheme === "token") return Option.some(Redacted.make(parameter));
  if (scheme !== "basic") return Option.none();
  return Result.getSuccess(Encoding.decodeBase64String(parameter)).pipe(
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
 * The caller token a request presents, wherever the Worker's tool puts its
 * credential: the gateway header, then `Authorization` (gh, Claude Code with
 * `ANTHROPIC_AUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN`, Codex, git with a
 * credential helper), then `x-api-key` (Claude Code with `ANTHROPIC_API_KEY`).
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

/** Removes every header that can carry a caller's credential. */
export const withoutCallerCredentials = (headers: Headers.Headers): Headers.Headers =>
  CALLER_CREDENTIAL_HEADERS.reduce((remaining, name) => Headers.remove(remaining, name), headers);
