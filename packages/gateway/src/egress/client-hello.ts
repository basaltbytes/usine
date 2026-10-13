import { Data, Option } from "effect";

/** The most bytes the forward proxy buffers while it waits for a whole ClientHello. */
export const CLIENT_HELLO_LIMIT = 16 * 1024;

const HANDSHAKE_RECORD = 0x16;
const CLIENT_HELLO = 0x01;
const SERVER_NAME = 0x0000;
const HOST_NAME = 0x00;
const ENCRYPTED_CLIENT_HELLO = 0xfe0d;
const MAX_RECORD_LENGTH = 1 << 14;

/**
 * What the first bytes of a tunnel say about the TLS connection inside it:
 * not enough bytes yet, with how many the reader needs before it can say
 * more; not a TLS ClientHello; or a ClientHello with the server name it asks
 * for and whether it encrypts the real one (ECH).
 */
export type ClientHelloRead = Data.TaggedEnum<{
  Incomplete: { readonly needed: number };
  NotTls: { readonly detail: string };
  ClientHello: {
    readonly serverName: Option.Option<string>;
    readonly encryptedClientHello: boolean;
  };
}>;
export const ClientHelloRead = Data.taggedEnum<ClientHelloRead>();

const notTls = (detail: string) => ClientHelloRead.NotTls({ detail });

const u16 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);

/** Reads the `host_name` entry of a `server_name` extension (RFC 6066, section 3). */
const hostName = (data: Uint8Array): Option.Option<string> => {
  if (data.length < 2 || u16(data, 0) !== data.length - 2) return Option.none();
  let at = 2;
  while (at + 3 <= data.length) {
    const type = data[at];
    const length = u16(data, at + 1);
    const start = at + 3;
    if (start + length > data.length) return Option.none();
    if (type === HOST_NAME && length > 0)
      return Option.some(new TextDecoder().decode(data.subarray(start, start + length)));
    at = start + length;
  }
  return Option.none();
};

/** Parses a ClientHello body: version, random, session id, cipher suites, compression methods, extensions (RFC 8446, section 4.1.2). */
const clientHelloBody = (body: Uint8Array): ClientHelloRead => {
  let at = 2 + 32;
  if (at + 1 > body.length) return notTls("ClientHello is truncated");
  at += 1 + (body[at] ?? 0);
  if (at + 2 > body.length) return notTls("ClientHello is truncated");
  at += 2 + u16(body, at);
  if (at + 1 > body.length) return notTls("ClientHello is truncated");
  at += 1 + (body[at] ?? 0);
  if (at > body.length) return notTls("ClientHello is truncated");
  if (at === body.length)
    return ClientHelloRead.ClientHello({ serverName: Option.none(), encryptedClientHello: false });
  if (at + 2 > body.length) return notTls("ClientHello extensions are truncated");
  const end = at + 2 + u16(body, at);
  if (end > body.length) return notTls("ClientHello extensions are truncated");
  at += 2;
  let serverName: Option.Option<string> = Option.none();
  let encryptedClientHello = false;
  while (at + 4 <= end) {
    const type = u16(body, at);
    const length = u16(body, at + 2);
    const start = at + 4;
    if (start + length > end) return notTls("a ClientHello extension is truncated");
    if (type === SERVER_NAME && Option.isNone(serverName))
      serverName = hostName(body.subarray(start, start + length));
    if (type === ENCRYPTED_CLIENT_HELLO) encryptedClientHello = true;
    at = start + length;
  }
  return ClientHelloRead.ClientHello({ serverName, encryptedClientHello });
};

/**
 * Reads the TLS ClientHello at the start of `bytes`, joining it across
 * handshake records if the client split it. While it answers `Incomplete`,
 * `needed` is the least number of bytes that can change the answer: the end
 * of the next record header or record, or, once the handshake header is
 * known, the rest of the ClientHello in one more record.
 */
export const readClientHello = (bytes: Uint8Array): ClientHelloRead => {
  const chunks: Array<Uint8Array> = [];
  let handshakeLength = 0;
  let at = 0;
  for (;;) {
    if (bytes.length > at && bytes[at] !== HANDSHAKE_RECORD)
      return notTls("the first bytes are not a TLS handshake record");
    if (bytes.length < at + 5) return ClientHelloRead.Incomplete({ needed: at + 5 });
    if (bytes[at + 1] !== 0x03) return notTls("the record version is not TLS");
    const length = u16(bytes, at + 3);
    if (length === 0 || length > MAX_RECORD_LENGTH) return notTls("the record length is invalid");
    if (bytes.length < at + 5 + length)
      return ClientHelloRead.Incomplete({ needed: at + 5 + length });
    chunks.push(bytes.subarray(at + 5, at + 5 + length));
    handshakeLength += length;
    at += 5 + length;
    if (handshakeLength < 4) continue;
    const handshake = new Uint8Array(handshakeLength);
    let filled = 0;
    for (const chunk of chunks) {
      handshake.set(chunk, filled);
      filled += chunk.length;
    }
    if (handshake[0] !== CLIENT_HELLO) return notTls("the handshake is not a ClientHello");
    const messageLength = ((handshake[1] ?? 0) << 16) | u16(handshake, 2);
    if (messageLength > CLIENT_HELLO_LIMIT) return notTls("the ClientHello is too large");
    if (handshakeLength >= 4 + messageLength)
      return clientHelloBody(handshake.subarray(4, 4 + messageLength));
    const rest = at + 5 + (4 + messageLength - handshakeLength);
    if (bytes.length < rest) return ClientHelloRead.Incomplete({ needed: rest });
  }
};

/**
 * Collects a tunnel's first bytes and parses them only once they reach the
 * count the last parse needed, so a client that sends one byte at a time
 * costs a few parses rather than one per byte. A ClientHello that needs more
 * than 16 KiB is refused as `NotTls`.
 */
export class ClientHelloReader {
  #chunks: Array<Uint8Array> = [];
  #length = 0;
  #needed = 1;
  #parses = 0;

  /** Adds bytes from the client and answers what they say so far. */
  push(chunk: Uint8Array): ClientHelloRead {
    this.#chunks.push(chunk);
    this.#length += chunk.length;
    if (this.#length < this.#needed) return ClientHelloRead.Incomplete({ needed: this.#needed });
    this.#parses += 1;
    const read = readClientHello(this.bytes);
    if (read._tag !== "Incomplete") return read;
    if (read.needed > CLIENT_HELLO_LIMIT) return notTls("the ClientHello is larger than 16 KiB");
    this.#needed = read.needed;
    return read;
  }

  /** Every byte collected so far, in order: what the proxy writes upstream once the tunnel opens. */
  get bytes(): Uint8Array {
    if (this.#chunks.length !== 1) {
      const joined = new Uint8Array(this.#length);
      let at = 0;
      for (const chunk of this.#chunks) {
        joined.set(chunk, at);
        at += chunk.length;
      }
      this.#chunks = [joined];
    }
    return this.#chunks[0] ?? new Uint8Array(0);
  }

  /** How many times the bytes were parsed. */
  get parses(): number {
    return this.#parses;
  }
}

/** A host name as TLS and CONNECT compare it: lowercase, without a trailing dot. */
export const comparableHost = (host: string): string => host.toLowerCase().replace(/\.$/u, "");
