import { Effect, Encoding, Redacted } from "effect";

/** A machine's SSH host key pair, which the executor generates before it creates the machine. */
export interface HostKeyPair {
  /** The public key as `known_hosts` writes it: `ssh-ed25519 <base64>`. */
  readonly publicKey: string;
  /** The private key as an unencrypted OpenSSH key file, which sshd reads. */
  readonly privateKey: Redacted.Redacted<string>;
}

const KEY_TYPE = "ssh-ed25519";

/** The length of the PKCS #8 header of an Ed25519 private key, which the 32-byte seed follows. */
const PKCS8_HEADER_LENGTH = 16;

const encoder = new TextEncoder();

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const joined = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
};

const uint32 = (value: number): Uint8Array => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
};

/** The SSH wire format's `string`: a 32-bit length, then the bytes. */
const sshBytes = (bytes: Uint8Array): Uint8Array => concat(uint32(bytes.length), bytes);

/** The SSH wire format's `string` of `text`'s UTF-8 bytes. */
const sshText = (text: string): Uint8Array => sshBytes(encoder.encode(text));

/** The magic that starts an OpenSSH private key: `openssh-key-v1` and a zero byte. */
const MAGIC = concat(encoder.encode("openssh-key-v1"), new Uint8Array(1));

/**
 * Returns the unencrypted OpenSSH key file of an Ed25519 key, in the format of `PROTOCOL.key`
 * in OpenSSH's sources. `check` is the random 32-bit value that the format writes twice.
 */
const openSshKeyFile = (seed: Uint8Array, publicKey: Uint8Array, check: Uint8Array): string => {
  const unpadded = concat(
    check,
    check,
    sshText(KEY_TYPE),
    sshBytes(publicKey),
    sshBytes(concat(seed, publicKey)),
    sshText(""),
  );
  const padding = Uint8Array.from(
    { length: (8 - (unpadded.length % 8)) % 8 },
    (_, index) => index + 1,
  );
  const body = concat(
    MAGIC,
    sshText("none"),
    sshText("none"),
    sshText(""),
    uint32(1),
    sshBytes(concat(sshText(KEY_TYPE), sshBytes(publicKey))),
    sshBytes(concat(unpadded, padding)),
  );
  return [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    ...(Encoding.encodeBase64(body).match(/.{1,70}/gu) ?? []),
    "-----END OPENSSH PRIVATE KEY-----",
    "",
  ].join("\n");
};

/** Generates an Ed25519 host key pair for a new machine. */
export const generateHostKey: Effect.Effect<HostKeyPair> = Effect.gen(function* () {
  const pair = yield* Effect.promise(() =>
    crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]),
  );
  if (!("privateKey" in pair))
    return yield* Effect.die(new Error("WebCrypto returned one Ed25519 key, not a pair"));
  const publicKey = new Uint8Array(
    yield* Effect.promise(() => crypto.subtle.exportKey("raw", pair.publicKey)),
  );
  const pkcs8 = new Uint8Array(
    yield* Effect.promise(() => crypto.subtle.exportKey("pkcs8", pair.privateKey)),
  );
  const seed = pkcs8.slice(PKCS8_HEADER_LENGTH);
  if (publicKey.length !== 32 || seed.length !== 32)
    return yield* Effect.die(new Error("WebCrypto exported an Ed25519 key of an unexpected size"));
  return {
    publicKey: `${KEY_TYPE} ${Encoding.encodeBase64(concat(sshText(KEY_TYPE), sshBytes(publicKey)))}`,
    privateKey: Redacted.make(
      openSshKeyFile(seed, publicKey, crypto.getRandomValues(new Uint8Array(4))),
    ),
  };
});
