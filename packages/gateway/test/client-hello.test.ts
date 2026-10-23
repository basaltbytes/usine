import { createServer } from "node:net";
import { connect } from "node:tls";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Predicate } from "effect";
import {
  CLIENT_HELLO_LIMIT,
  ClientHelloReader,
  comparableHost,
  readClientHello,
} from "../src/egress/client-hello.ts";

const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
const u24 = (value: number) => [(value >> 16) & 0xff, ...u16(value)];

const extension = (type: number, data: ReadonlyArray<number>) => [
  ...u16(type),
  ...u16(data.length),
  ...data,
];

const serverNameExtension = (name: string) => {
  const bytes = [...new TextEncoder().encode(name)];
  const entry = [0x00, ...u16(bytes.length), ...bytes];
  return extension(0x0000, [...u16(entry.length), ...entry]);
};

/** Returns a ClientHello handshake message with `extensions`, in the RFC 8446 layout. */
const clientHello = (extensions: ReadonlyArray<ReadonlyArray<number>>) => {
  const body = [
    0x03,
    0x03,
    ...Array.from({ length: 32 }, () => 7),
    32,
    ...Array.from({ length: 32 }, () => 9),
    ...u16(2),
    0x13,
    0x01,
    1,
    0x00,
    ...u16(extensions.flat().length),
    ...extensions.flat(),
  ];
  return [0x01, ...u24(body.length), ...body];
};

/** Wraps handshake bytes in TLS records of at most `size` bytes each. */
const records = (handshake: ReadonlyArray<number>, size = 1 << 14) => {
  const out: Array<number> = [];
  for (let at = 0; at < handshake.length; at += size) {
    const fragment = handshake.slice(at, at + size);
    out.push(0x16, 0x03, 0x01, ...u16(fragment.length), ...fragment);
  }
  return Uint8Array.from(out);
};

const SUPPORTED_VERSIONS = extension(0x002b, [2, 0x03, 0x04]);

const serverNameOf = (bytes: Uint8Array) => {
  const read = readClientHello(bytes);
  assert(read._tag === "ClientHello", `expected a ClientHello, got ${read._tag}`);
  return read;
};

/** Returns the first bytes Node's TLS client sends for `servername`, captured by a local listener. */
const nodeClientHello = (servername: string) =>
  Effect.callback<Uint8Array>((resume) => {
    const server = createServer((socket) => {
      socket.once("data", (chunk: Buffer) => {
        resume(Effect.succeed(new Uint8Array(chunk)));
        socket.destroy();
        server.close();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address === null || Predicate.isString(address) ? 0 : address.port;
      const client = connect({ host: "127.0.0.1", port, servername });
      client.on("error", () => client.destroy());
    });
  });

describe("readClientHello", () => {
  it.effect("reads the server name from the ClientHello Node's TLS client sends", () =>
    Effect.gen(function* () {
      const read = serverNameOf(yield* nodeClientHello("registry.npmjs.org"));
      assert.deepStrictEqual(read.serverName, Option.some("registry.npmjs.org"));
      assert.isFalse(read.encryptedClientHello);
    }),
  );

  it("waits for the whole ClientHello, even when the client splits it across records", () => {
    const handshake = clientHello([serverNameExtension("pypi.org"), SUPPORTED_VERSIONS]);
    const whole = records(handshake);
    for (const length of [0, 1, 4, 5, 20, whole.length - 1])
      assert.strictEqual(readClientHello(whole.subarray(0, length))._tag, "Incomplete");
    assert.deepStrictEqual(serverNameOf(whole).serverName, Option.some("pypi.org"));
    const split = records(handshake, 25);
    assert.strictEqual(readClientHello(split.subarray(0, split.length - 3))._tag, "Incomplete");
    assert.deepStrictEqual(serverNameOf(split).serverName, Option.some("pypi.org"));
  });

  it("reports a ClientHello without a server name, and one that encrypts it", () => {
    assert.deepStrictEqual(
      serverNameOf(records(clientHello([SUPPORTED_VERSIONS]))).serverName,
      Option.none(),
    );
    const encrypted = serverNameOf(
      records(
        clientHello([serverNameExtension("cloudflare-ech.com"), extension(0xfe0d, [0, 1, 2, 3])]),
      ),
    );
    assert.isTrue(encrypted.encryptedClientHello);
  });

  it("parses a ClientHello sent one byte at a time a few times, not once per byte", () => {
    const handshake = clientHello([serverNameExtension("registry.npmjs.org"), SUPPORTED_VERSIONS]);
    const feed = (wire: Uint8Array) => {
      const reader = new ClientHelloReader();
      const reads = [...wire].map((byte) => reader.push(Uint8Array.of(byte)));
      const read = reads.at(-1);
      assert(read?._tag === "ClientHello", `expected a ClientHello, got ${read?._tag}`);
      assert.deepStrictEqual(read.serverName, Option.some("registry.npmjs.org"));
      assert.deepStrictEqual(reader.bytes, wire);
      return reader.parses;
    };
    // The first byte, the record header, the whole record.
    assert.strictEqual(feed(records(handshake)), 3);
    const split = records(handshake, 16);
    const recordCount = Math.ceil(handshake.length / 16);
    assert.isAtMost(feed(split), 2 * recordCount + 1);
  });

  it("refuses a ClientHello that would need more than 16 KiB", () => {
    const reader = new ClientHelloReader();
    const header = Uint8Array.from([
      0x16,
      0x03,
      0x01,
      ...u16(16_000),
      0x01,
      ...u24(CLIENT_HELLO_LIMIT),
    ]);
    assert.strictEqual(reader.push(header)._tag, "Incomplete");
    const next = new Uint8Array(16_000 - 4);
    const read = reader.push(next);
    assert.strictEqual(read._tag, "NotTls");
  });

  it("refuses bytes that are not a TLS ClientHello", () => {
    const notTls = (bytes: ReadonlyArray<number>) =>
      assert.strictEqual(readClientHello(Uint8Array.from(bytes))._tag, "NotTls");
    notTls([...new TextEncoder().encode("GET / HTTP/1.1\r\n\r\n")]);
    notTls([0x16, 0x02, 0x00, 0x00, 0x04, 0x01, 0x00, 0x00, 0x00]);
    notTls([0x16, 0x03, 0x01, 0x00, 0x00]);
    notTls([0x16, 0x03, 0x01, 0x00, 0x04, 0x02, 0x00, 0x00, 0x00]);
    const truncatedExtensions = clientHello([serverNameExtension("pypi.org")]);
    truncatedExtensions.splice(truncatedExtensions.length - 4, 1);
    truncatedExtensions.splice(1, 3, ...u24(truncatedExtensions.length - 4));
    notTls([...records(truncatedExtensions)]);
  });

  it("compares host names without case or a trailing dot", () => {
    assert.strictEqual(comparableHost("Registry.NPMJS.org."), "registry.npmjs.org");
  });
});
