import { assert, describe, it } from "@effect/vitest";
import { Effect, Redacted, Result } from "effect";
import { Base64 } from "effect/encoding";
import { generateHostKey } from "../../../src/ssh/provisioner/host-key.ts";

const decoder = new TextDecoder();

const base64 = (text: string): Uint8Array => {
  const decoded = Base64.decode(text);
  assert(Result.isSuccess(decoded));
  return decoded.success;
};

/** Reads the SSH wire format's strings and 32-bit integers from `bytes`. */
const reader = (bytes: Uint8Array) => {
  let offset = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const uint32 = () => {
    const value = view.getUint32(offset);
    offset += 4;
    return value;
  };
  const bytesOf = (length: number) => {
    const value = bytes.slice(offset, offset + length);
    offset += length;
    return value;
  };
  return {
    uint32,
    bytes: bytesOf,
    string: () => bytesOf(uint32()),
    text: () => decoder.decode(bytesOf(uint32())),
    rest: () => bytes.slice(offset),
  };
};

/** The PKCS #8 header of an Ed25519 private key, which WebCrypto imports with the seed after it. */
const PKCS8_HEADER = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

describe("generateHostKey", () => {
  it.effect(
    "writes an unencrypted OpenSSH Ed25519 key file whose key signs for the public key",
    () =>
      Effect.gen(function* () {
        const pair = yield* generateHostKey;
        const [type, encodedPublic, ...rest] = pair.publicKey.split(" ");
        assert.strictEqual(type, "ssh-ed25519");
        assert.lengthOf(rest, 0);
        const publicBlob = reader(base64(encodedPublic ?? ""));
        assert.strictEqual(publicBlob.text(), "ssh-ed25519");
        const publicKey = publicBlob.string();
        assert.lengthOf(publicKey, 32);

        const lines = Redacted.value(pair.privateKey).split("\n");
        assert.strictEqual(lines[0], "-----BEGIN OPENSSH PRIVATE KEY-----");
        assert.deepStrictEqual(lines.slice(-2), ["-----END OPENSSH PRIVATE KEY-----", ""]);
        assert.isTrue(lines.slice(1, -2).every((line) => line.length > 0 && line.length <= 70));
        const file = reader(base64(lines.slice(1, -2).join("")));
        assert.deepStrictEqual(
          [...file.bytes(15)],
          [...new TextEncoder().encode("openssh-key-v1"), 0],
        );
        assert.strictEqual(file.text(), "none");
        assert.strictEqual(file.text(), "none");
        assert.lengthOf(file.string(), 0);
        assert.strictEqual(file.uint32(), 1);
        assert.deepStrictEqual(file.string(), base64(encodedPublic ?? ""));
        const section = file.string();
        assert.lengthOf(file.rest(), 0);
        assert.strictEqual(section.length % 8, 0);

        const keys = reader(section);
        assert.strictEqual(keys.uint32(), keys.uint32());
        assert.strictEqual(keys.text(), "ssh-ed25519");
        assert.deepStrictEqual(keys.string(), publicKey);
        const secret = keys.string();
        assert.lengthOf(secret, 64);
        assert.deepStrictEqual(secret.slice(32), publicKey);
        assert.strictEqual(keys.text(), "");
        const padding = keys.rest();
        assert.deepStrictEqual(
          [...padding],
          Array.from({ length: padding.length }, (_, index) => index + 1),
        );

        const message = new TextEncoder().encode("usine host key");
        const signing = yield* Effect.promise(() =>
          crypto.subtle.importKey(
            "pkcs8",
            Uint8Array.from([...PKCS8_HEADER, ...secret.slice(0, 32)]),
            { name: "Ed25519" },
            false,
            ["sign"],
          ),
        );
        const verifying = yield* Effect.promise(() =>
          crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]),
        );
        const signature = yield* Effect.promise(() =>
          crypto.subtle.sign({ name: "Ed25519" }, signing, message),
        );
        assert.isTrue(
          yield* Effect.promise(() =>
            crypto.subtle.verify({ name: "Ed25519" }, verifying, signature, message),
          ),
        );
        assert.notStrictEqual((yield* generateHostKey).publicKey, pair.publicKey);
      }),
  );
});
