import { Effect, Redacted } from "effect";
import { ACCESS_CLIENT_ID_HEADER, ACCESS_CLIENT_SECRET_HEADER } from "./api/api.ts";

/** The Cloudflare Access service token that the Worker accepts. */
export interface AccessToken {
  readonly clientId: Redacted.Redacted<string>;
  readonly clientSecret: Redacted.Redacted<string>;
}

const encoder = new TextEncoder();

const digest = (value: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", encoder.encode(value))).pipe(
    Effect.map((bytes) => new Uint8Array(bytes)),
  );

/** Returns whether two digests are equal, in constant time. */
const sameDigest = (left: Uint8Array, right: Uint8Array): boolean => {
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.min(left.length, right.length); index++)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
};

/**
 * Returns whether `headers` carry `token` in the Access service token headers. A request
 * without either header is refused.
 */
export const accessGranted = Effect.fn("SandboxWorker.accessGranted")(function* (
  headers: Headers,
  token: AccessToken,
) {
  const clientId = headers.get(ACCESS_CLIENT_ID_HEADER);
  const clientSecret = headers.get(ACCESS_CLIENT_SECRET_HEADER);
  if (clientId === null || clientSecret === null) return false;
  const [presentedId, presentedSecret, expectedId, expectedSecret] = yield* Effect.all([
    digest(clientId),
    digest(clientSecret),
    digest(Redacted.value(token.clientId)),
    digest(Redacted.value(token.clientSecret)),
  ]);
  // Both comparisons run, so the response time doesn't tell which header was wrong.
  const idMatches = sameDigest(presentedId, expectedId);
  const secretMatches = sameDigest(presentedSecret, expectedSecret);
  return idMatches && secretMatches;
});
