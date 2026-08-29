import { Clock, Context, Effect, Layer, Redacted } from "effect";
import { AppAuthenticationError, type AppCredentials } from "./model.ts";

interface JwtHeader {
  readonly alg: "RS256";
  readonly typ: "JWT";
}

interface JwtClaims {
  readonly iat: number;
  readonly exp: number;
  readonly iss: number;
}

const encoder = new TextEncoder();
const RSA_ALGORITHM_IDENTIFIER = new Uint8Array([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]);

const concat = (...values: ReadonlyArray<Uint8Array>): Uint8Array => {
  const output = new Uint8Array(values.reduce((size, value) => size + value.length, 0));
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.length;
  }
  return output;
};

const derLength = (length: number): Uint8Array => {
  if (length < 0x80) return new Uint8Array([length]);
  const bytes: Array<number> = [];
  for (let remaining = length; remaining > 0; remaining >>>= 8) bytes.unshift(remaining & 0xff);
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
};

const der = (tag: number, value: Uint8Array): Uint8Array =>
  concat(new Uint8Array([tag]), derLength(value.length), value);

const wrapPkcs1AsPkcs8 = (pkcs1: Uint8Array): Uint8Array =>
  der(0x30, concat(new Uint8Array([0x02, 0x01, 0x00]), RSA_ALGORITHM_IDENTIFIER, der(0x04, pkcs1)));

const decodePem = (pem: string): Uint8Array => {
  const pkcs1 = pem.includes("-----BEGIN RSA PRIVATE KEY-----");
  const base64 = pem
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/gu, "")
    .replace(/-----END (?:RSA )?PRIVATE KEY-----/gu, "")
    .replace(/\s/gu, "");
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return pkcs1 ? wrapPkcs1AsPkcs8(bytes) : bytes;
};

const base64Url = (value: Uint8Array): string => {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/gu, "").replace(/\+/gu, "-").replace(/\//gu, "_");
};

const encodeJson = (value: JwtHeader | JwtClaims): string =>
  base64Url(encoder.encode(JSON.stringify(value)));

const toArrayBuffer = (value: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(value.byteLength);
  new Uint8Array(buffer).set(value);
  return buffer;
};

/** Universal WebCrypto signer for GitHub App JWTs. */
export class AppJwtSigner extends Context.Service<
  AppJwtSigner,
  {
    readonly sign: (
      credentials: AppCredentials,
    ) => Effect.Effect<Redacted.Redacted<string>, AppAuthenticationError>;
  }
>()("@usine/github/AppJwtSigner") {
  static readonly layer = Layer.succeed(AppJwtSigner, {
    sign: Effect.fn("AppJwtSigner.sign")(function* (credentials: AppCredentials) {
      const now = yield* Clock.currentTimeMillis;
      const issuedAt = Math.floor(now / 1_000) - 60;
      const expiresAt = Math.floor(now / 1_000) + 9 * 60;
      const unsigned = `${encodeJson({ alg: "RS256", typ: "JWT" })}.${encodeJson({
        iat: issuedAt,
        exp: expiresAt,
        iss: credentials.appId,
      })}`;

      const jwt = yield* Effect.tryPromise({
        try: async () => {
          const key = await crypto.subtle.importKey(
            "pkcs8",
            toArrayBuffer(decodePem(Redacted.value(credentials.privateKey))),
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            false,
            ["sign"],
          );
          const signature = await crypto.subtle.sign(
            "RSASSA-PKCS1-v1_5",
            key,
            toArrayBuffer(encoder.encode(unsigned)),
          );
          return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
        },
        catch: () =>
          new AppAuthenticationError({
            message: "The GitHub App private key could not sign an RS256 JWT",
          }),
      });
      return Redacted.make(jwt, { label: "GitHub App JWT" });
    }),
  });
}
