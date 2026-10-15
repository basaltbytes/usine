import { lookup } from "node:dns/promises";
import { BlockList, connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { WorkerName } from "@usine/core/worker";
import { Data, Effect, Option, Schema } from "effect";
import { ClientHelloReader, comparableHost } from "../../egress/client-hello.ts";
import {
  type EgressPermitted,
  EgressRefused,
  type EgressRefusalReason,
} from "../../egress/egress.ts";
import { GatewaySettings } from "../../settings.ts";

/**
 * Addresses a public name must never resolve to: private, loopback,
 * link-local, shared, multicast, and reserved ranges. Node checks IPv4-mapped
 * IPv6 addresses against the IPv4 ranges, and a `::ffff:0:0/96` rule would
 * match every IPv4 address.
 */
const privateAddresses = (): BlockList => {
  const list = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["224.0.0.0", 3],
  ] as const)
    list.addSubnet(network, prefix, "ipv4");
  for (const [network, prefix] of [
    ["::", 127],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ] as const)
    list.addSubnet(network, prefix, "ipv6");
  return list;
};

/** The DNS lookup of an allowed host failed or returned nothing. */
export class Unresolvable extends Schema.TaggedError<Unresolvable>()("Unresolvable", {
  host: Schema.String,
}) {}

/** The upstream connection could not be opened or its response did not finish. */
export class Unreachable extends Schema.TaggedError<Unreachable>()("Unreachable", {
  host: Schema.String,
  port: Schema.Int,
  message: Schema.String,
}) {}

/**
 * A TLS connection refused once its first bytes were read: they were not a
 * TLS ClientHello, it named no server or hid it with ECH, it named another
 * server than the CONNECT host or one the allowlist does not permit, or the
 * host resolved to a private address. `serverName` is the name the
 * ClientHello asked for, if any.
 */
class TunnelRefused extends Data.TaggedError("TunnelRefused")<{
  readonly reason: EgressRefusalReason;
  readonly detail: string;
  readonly serverName: Option.Option<string>;
}> {}

/** A fatal TLS `unrecognized_name` alert (RFC 8446, section 6), so a client reports why its handshake ended. */
const UNRECOGNIZED_NAME_ALERT = Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x70]);

const CLIENT_HELLO_TIMEOUT = "5 seconds";

/** The port every TLS tunnel goes to upstream. */
const HTTPS_PORT = 443;

const notTls = (detail: string) =>
  new TunnelRefused({ reason: "not-tls", detail, serverName: Option.none() });

interface ClientHello {
  readonly buffered: Buffer;
  readonly serverName: Option.Option<string>;
  readonly encryptedClientHello: boolean;
}

/**
 * Buffers a connection's first bytes, `head` included, until they contain a
 * whole TLS ClientHello, at most 16 KiB and five seconds, parsing only when
 * enough bytes have arrived, then pauses the client so nothing more is read
 * before the upstream connection exists.
 */
const clientHello = (client: Duplex, head: Buffer) =>
  Effect.callback<ClientHello, TunnelRefused>((resume) => {
    const reader = new ClientHelloReader();
    const stop = () => {
      client.off("data", onData);
      client.off("end", onEnd);
      client.off("close", onEnd);
    };
    function onData(chunk: Buffer) {
      const read = reader.push(chunk);
      if (read._tag === "Incomplete") return;
      stop();
      client.pause();
      if (read._tag === "NotTls") return resume(Effect.fail(notTls(read.detail)));
      resume(
        Effect.succeed({
          buffered: Buffer.from(reader.bytes),
          serverName: read.serverName,
          encryptedClientHello: read.encryptedClientHello,
        }),
      );
    }
    function onEnd() {
      stop();
      resume(Effect.fail(notTls("the client closed the connection before sending a ClientHello")));
    }
    client.on("data", onData);
    client.once("end", onEnd);
    client.once("close", onEnd);
    if (head.length > 0) onData(head);
    return Effect.sync(stop);
  }).pipe(
    Effect.timeoutOrElse({
      duration: CLIENT_HELLO_TIMEOUT,
      orElse: () => Effect.fail(notTls("no ClientHello arrived within five seconds")),
    }),
  );

/** The server name a ClientHello asks for in the clear; a ClientHello without one, or with ECH, cannot be checked. */
const namedServer = (hello: ClientHello): Effect.Effect<string, TunnelRefused> => {
  if (hello.encryptedClientHello)
    return Effect.fail(
      new TunnelRefused({
        reason: "server-name-missing",
        detail: "the ClientHello encrypts its server name (ECH), so it cannot be checked",
        serverName: hello.serverName,
      }),
    );
  return Option.match(hello.serverName, {
    onNone: () =>
      Effect.fail(
        new TunnelRefused({
          reason: "server-name-missing",
          detail: "the ClientHello names no server",
          serverName: Option.none(),
        }),
      ),
    onSome: Effect.succeed,
  });
};

/**
 * How a TLS connection reached the gateway, which decides what its
 * ClientHello must name. `Connect` is a CONNECT through the forward proxy
 * that the allowlist permitted: the ClientHello must name the CONNECT host
 * itself, so one allowed name on a shared CDN address cannot carry a
 * connection to another tenant of it. `Transparent` is a connection to the
 * transparent listener from a client that ignores proxy variables: the
 * ClientHello's server name must be on the allowlist for port 443.
 */
export type TunnelEntry = Data.TaggedEnum<{
  Connect: { readonly host: string; readonly permitted: EgressPermitted };
  Transparent: {};
}>;
export const TunnelEntry = Data.taggedEnum<TunnelEntry>();

/** The caller of a forward proxy request as it appears in logs. */
export type CallerFields =
  | { readonly worker: WorkerName }
  | { readonly caller: "none" | "invalid-token" };

/** Who opened a connection, for its log lines: the client address and the caller. */
export type ConnectionFields = { readonly client: string } & CallerFields;

/** Opens a TCP connection to `address` and `port`; `host` is the name it stands for, in errors. */
export const connectTo = (address: string, port: number, host: string) =>
  Effect.callback<Socket, Unreachable>((resume) => {
    const socket = connect({ host: address, port });
    const onError = (error: Error) =>
      resume(Effect.fail(new Unreachable({ host, port, message: error.message })));
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      resume(Effect.succeed(socket));
    });
    return Effect.sync(() => socket.destroy());
  });

/**
 * The fields of a tunnel's log lines: who opened it, and where it goes,
 * either to the gateway's own reverse proxy or to an allowlisted host by
 * the server name its ClientHello asked for, through one way in.
 */
export type TunnelFields = ConnectionFields & { readonly host: string; readonly port: number } & (
    | { readonly destination: "gateway" }
    | {
        readonly destination: "egress";
        readonly serverName: string;
        readonly via: "connect" | "transparent";
      }
  );

/**
 * Copies bytes both ways until either side closes, then closes both and logs
 * `fields` with which side closed first and how many bytes went each way, so
 * no upstream connection outlives its client.
 */
export const splice = <Fields extends TunnelFields>(
  client: Duplex,
  upstream: Socket,
  fields: Fields,
) =>
  Effect.callback<"client" | "upstream">((resume) => {
    const closedBy = (side: "client" | "upstream") => () => {
      client.destroy();
      upstream.destroy();
      resume(Effect.succeed(side));
    };
    client.on("error", closedBy("client")).on("close", closedBy("client"));
    upstream.on("error", closedBy("upstream")).on("close", closedBy("upstream"));
    client.pipe(upstream);
    upstream.pipe(client);
    return Effect.sync(() => {
      client.destroy();
      upstream.destroy();
    });
  }).pipe(
    Effect.flatMap((side) =>
      Effect.logInfo("Closed an egress tunnel", {
        ...fields,
        closedBy: side,
        sent: upstream.bytesWritten,
        received: upstream.bytesRead,
      }),
    ),
  );

/**
 * The TLS relay both ways in share, the forward proxy's CONNECT tunnels and
 * the transparent listener: no certificate authority, no interception. It
 * reads the client's ClientHello, checks its server name for the way the
 * connection came in, resolves the host itself and refuses one that
 * resolves to a private address, so an allowlisted name cannot be pointed at
 * the gateway's own network, connects to the host on port 443, forwards the
 * bytes read so far, and copies bytes both ways. No upstream connection
 * exists until the server name is checked.
 */
export const egressTunnels = Effect.gen(function* () {
  const settings = yield* GatewaySettings;
  const blocked = privateAddresses();

  /** Resolves an allowed host and returns the first address, or refuses when any address is private. */
  const resolve = Effect.fn("EgressTunnel.resolve")(function* (permitted: EgressPermitted) {
    const addresses = yield* Effect.tryPromise({
      try: () => lookup(permitted.host, { all: true, verbatim: true }),
      catch: () => new Unresolvable({ host: permitted.host }),
    });
    const first = addresses[0];
    if (first === undefined) return yield* new Unresolvable({ host: permitted.host });
    if (
      addresses.some(({ address, family }) =>
        blocked.check(address, family === 6 ? "ipv6" : "ipv4"),
      )
    )
      return yield* Effect.fail(
        new EgressRefused({
          host: permitted.host,
          port: permitted.port,
          reason: "private-address",
        }),
      );
    return first.address;
  });

  /** The destination a ClientHello's server name may open, for the way the connection came in. */
  const admit = (
    entry: TunnelEntry,
    serverName: string,
  ): Effect.Effect<EgressPermitted, TunnelRefused> =>
    TunnelEntry.$match(entry, {
      Connect: ({ host, permitted }) =>
        comparableHost(serverName) === comparableHost(host)
          ? Effect.succeed(permitted)
          : Effect.fail(
              new TunnelRefused({
                reason: "server-name-mismatch",
                detail: `the ClientHello asks for ${serverName}, not the CONNECT host`,
                serverName: Option.some(serverName),
              }),
            ),
      Transparent: () => {
        const decision = settings.egress.decide(serverName, HTTPS_PORT);
        return decision._tag === "EgressPermitted"
          ? Effect.succeed(decision)
          : Effect.fail(
              new TunnelRefused({
                reason: decision.reason,
                detail: `the ClientHello asks for ${serverName}, which the egress allowlist does not permit on port ${HTTPS_PORT}`,
                serverName: Option.some(serverName),
              }),
            );
      },
    });

  /** Refuses a connection whose first bytes were read, when closing it is all that is left. */
  const closeRefused = (client: Duplex, refusal: TunnelRefused) => {
    if (refusal.reason === "not-tls") client.destroy();
    else client.end(UNRECOGNIZED_NAME_ALERT);
  };

  /**
   * Relays one TLS connection: `head` is what the client sent before the
   * relay took it over, and `fields` say who opened it, for every log line.
   * The host in logs is the CONNECT host, or the server name the ClientHello
   * asked for on the transparent listener.
   */
  const relay = Effect.fn("EgressTunnel.relay")(
    function* (client: Duplex, head: Buffer, entry: TunnelEntry, fields: ConnectionFields) {
      const via = entry._tag === "Connect" ? "connect" : "transparent";
      const loggedHost = (serverName: Option.Option<string>) =>
        entry._tag === "Connect" ? entry.host : Option.getOrElse(serverName, () => "none");
      yield* Effect.annotateCurrentSpan({ via });
      const opened = yield* clientHello(client, head).pipe(
        Effect.flatMap((hello) =>
          namedServer(hello).pipe(
            Effect.flatMap((serverName) =>
              admit(entry, serverName).pipe(
                Effect.map((permitted) => ({ buffered: hello.buffered, serverName, permitted })),
              ),
            ),
          ),
        ),
        Effect.flatMap(({ buffered, serverName, permitted }) =>
          resolve(permitted).pipe(
            Effect.catchTag("EgressRefused", (refused) =>
              Effect.fail(
                new TunnelRefused({
                  reason: "private-address",
                  detail: `${refused.host} resolves to a private address`,
                  serverName: Option.some(serverName),
                }),
              ),
            ),
            Effect.flatMap((address) => connectTo(address, HTTPS_PORT, permitted.host)),
            Effect.map((upstream) => ({ upstream, buffered, serverName })),
          ),
        ),
        Effect.result,
      );
      if (opened._tag === "Failure") {
        const failure = opened.failure;
        if (failure._tag === "TunnelRefused") {
          closeRefused(client, failure);
          return yield* Effect.logWarning("Gateway refused a request", {
            reason: failure.reason,
            host: loggedHost(failure.serverName),
            port: HTTPS_PORT,
            serverName: Option.getOrElse(failure.serverName, () => "none"),
            detail: failure.detail,
            via,
            ...fields,
          });
        }
        client.destroy();
        return yield* Effect.logError("An allowed egress host could not be reached", {
          host: entry._tag === "Connect" ? entry.host : failure.host,
          port: HTTPS_PORT,
          via,
          ...fields,
          error: failure._tag,
        });
      }
      const { upstream, buffered, serverName } = opened.success;
      upstream.write(buffered);
      const opening = {
        host: loggedHost(Option.some(serverName)),
        port: HTTPS_PORT,
        serverName,
        destination: "egress",
        via,
        ...fields,
      } satisfies TunnelFields;
      yield* Effect.logInfo("Opened an egress tunnel", opening);
      yield* splice(client, upstream, opening);
    },
    // A relay the gateway's shutdown interrupts closes its client, whatever step it was at.
    (effect, client) => Effect.onInterrupt(effect, () => Effect.sync(() => client.destroy())),
  );

  return { resolve, relay };
});
