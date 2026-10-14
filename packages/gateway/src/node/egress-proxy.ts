import { lookup } from "node:dns/promises";
import {
  createServer,
  type IncomingMessage,
  request as httpRequest,
  type ServerResponse,
} from "node:http";
import { BlockList, connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { WorkerName } from "@usine/core/worker";
import { Data, Effect, Fiber, Match, Option, Predicate, Schema } from "effect";
import { Headers } from "effect/unstable/http";
import { tokenFromAuthorization, CallerTokens } from "../caller/caller.ts";
import { ClientHelloReader, comparableHost } from "../egress/client-hello.ts";
import { type EgressPermitted, EgressRefused } from "../egress/egress.ts";
import { endToEndHeaders } from "../proxy/forward.ts";
import { REFUSAL_HEADER } from "../proxy/proxy.ts";
import { GatewaySettings, gatewayHosts } from "../settings.ts";
import type { Listener } from "./environment.ts";

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
class Unresolvable extends Schema.TaggedError<Unresolvable>()("Unresolvable", {
  host: Schema.String,
}) {}

/** The forward proxy could not listen on its address. */
export class EgressProxyListenError extends Schema.TaggedError<EgressProxyListenError>()(
  "EgressProxyListenError",
  { host: Schema.String, port: Schema.Int, message: Schema.String },
) {}

/** The upstream connection could not be opened or its response did not finish. */
class Unreachable extends Schema.TaggedError<Unreachable>()("Unreachable", {
  host: Schema.String,
  port: Schema.Int,
  message: Schema.String,
}) {}

/**
 * A tunnel refused after its `200 Connection Established`: the client's first
 * bytes were not a TLS ClientHello, named no server or hid it with ECH, named
 * another server than the CONNECT host, or the host resolved to a private
 * address. `serverName` is the name the ClientHello asked for, if any.
 */
class TunnelRefused extends Data.TaggedError("TunnelRefused")<{
  readonly reason: "not-tls" | "server-name-missing" | "server-name-mismatch" | "private-address";
  readonly detail: string;
  readonly serverName: Option.Option<string>;
}> {}

/** A fatal TLS `unrecognized_name` alert (RFC 8446, section 6), so a client reports why its handshake ended. */
const UNRECOGNIZED_NAME_ALERT = Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x70]);

const CLIENT_HELLO_TIMEOUT = "5 seconds";

const notTls = (detail: string) =>
  new TunnelRefused({ reason: "not-tls", detail, serverName: Option.none() });

/**
 * Buffers a tunnel's first bytes, `head` included, until they contain a whole
 * TLS ClientHello, at most 16 KiB and five seconds, parsing only when enough
 * bytes have arrived, then pauses the client so nothing more is read before
 * the upstream connection exists.
 */
const clientHello = (client: Duplex, head: Buffer) =>
  Effect.callback<
    {
      readonly buffered: Buffer;
      readonly serverName: Option.Option<string>;
      readonly encryptedClientHello: boolean;
    },
    TunnelRefused
  >((resume) => {
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
      resume(Effect.fail(notTls("the client closed the tunnel before sending a ClientHello")));
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

/**
 * Checks that the ClientHello asks for the CONNECT host itself. On a shared
 * CDN address the same tunnel could otherwise carry a TLS connection to any
 * other tenant of that address.
 */
const pinnedServerName = (
  host: string,
  hello: {
    readonly buffered: Buffer;
    readonly serverName: Option.Option<string>;
    readonly encryptedClientHello: boolean;
  },
): Effect.Effect<{ readonly buffered: Buffer; readonly serverName: string }, TunnelRefused> => {
  if (hello.encryptedClientHello)
    return Effect.fail(
      new TunnelRefused({
        reason: "server-name-missing",
        detail: "the ClientHello encrypts its server name (ECH), so it cannot be checked",
        serverName: hello.serverName,
      }),
    );
  if (Option.isNone(hello.serverName))
    return Effect.fail(
      new TunnelRefused({
        reason: "server-name-missing",
        detail: "the ClientHello names no server",
        serverName: Option.none(),
      }),
    );
  const serverName = hello.serverName.value;
  return comparableHost(serverName) === comparableHost(host)
    ? Effect.succeed({ buffered: hello.buffered, serverName })
    : Effect.fail(
        new TunnelRefused({
          reason: "server-name-mismatch",
          detail: `the ClientHello asks for ${serverName}, not the CONNECT host`,
          serverName: hello.serverName,
        }),
      );
};

/** The caller of a forward proxy request as it appears in logs. */
type CallerFields = { readonly worker: WorkerName } | { readonly caller: "none" | "invalid-token" };

/** Where the proxy connects for a request: the gateway's reverse proxy, or an allowed host's address. */
interface Destination {
  readonly address: string;
  readonly port: number;
  readonly kind: "gateway" | "egress";
}

/**
 * How a plain HTTP relay ended: the upstream response was copied whole, or
 * the client closed its connection first, with the upstream status if the
 * response had begun.
 */
type RelayEnd = Data.TaggedEnum<{
  Relayed: { readonly status: number };
  Abandoned: { readonly status: Option.Option<number> };
}>;
const RelayEnd = Data.taggedEnum<RelayEnd>();

const AUTHORITY = /^(?:\[([0-9a-fA-F:.]+)\]|([^:[\]]+)):(\d{1,5})$/u;

const parseAuthority = (authority: string): Option.Option<{ host: string; port: number }> => {
  const match = AUTHORITY.exec(authority);
  const host = match?.[1] ?? match?.[2];
  if (match === null || host === undefined) return Option.none();
  return Option.some({ host, port: Number(match[3]) });
};

const statusLine = (status: number, reason: string, body: string, refusal: Option.Option<string>) =>
  [
    `HTTP/1.1 ${status} ${reason}`,
    "Content-Type: text/plain; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    ...Option.match(refusal, {
      onNone: () => [],
      onSome: (value) => [`${REFUSAL_HEADER}: ${value}`],
    }),
    "Connection: close",
    "",
    body,
  ].join("\r\n");

/**
 * Serves the forward proxy Workers use for package registries and other
 * allowlisted hosts: `CONNECT host:443` for HTTPS, and absolute-form
 * requests (`GET http://host/...`) for plain HTTP mirrors such as apt. A
 * tunnel is opened only after the client's TLS ClientHello names the CONNECT
 * host itself, so one allowed name on a shared address cannot carry a
 * connection to another tenant of it. The proxy resolves each name itself and
 * refuses one that resolves to a private address, so an allowlisted name
 * cannot be pointed at the gateway's own network. A client that sends every request through a proxy, as Claude Code
 * does with `HTTPS_PROXY` set, still reaches `git.<domain>` and
 * `llm.<domain>` on port 80: those go to the reverse proxy at `gateway`. A
 * caller token in `Proxy-Authorization` is optional and only names the Worker
 * in logs. Every refusal is logged with the host, the reason, and the client
 * address.
 */
export const serveEgressProxy = Effect.fn("EgressProxy.serve")(function* (
  listener: Listener,
  gateway: Listener,
) {
  const settings = yield* GatewaySettings;
  const ownHosts: ReadonlySet<string> = new Set(Object.values(gatewayHosts(settings.domain)));
  const callers = yield* CallerTokens;
  const blocked = privateAddresses();
  const scope = yield* Effect.scope;
  const context = yield* Effect.context<never>();

  /** Who a request comes from, for its log lines: the Worker its caller token names, if it sent a valid one. */
  const caller = (value: string | undefined): Effect.Effect<CallerFields> =>
    Option.fromNullishOr(value).pipe(
      Option.flatMap(tokenFromAuthorization),
      Option.match({
        onNone: () => Effect.succeed({ caller: "none" }),
        onSome: (token) =>
          callers.verify(token).pipe(
            Effect.map(({ worker }): CallerFields => ({ worker })),
            Effect.orElseSucceed((): CallerFields => ({ caller: "invalid-token" })),
          ),
      }),
    );

  const logRefusal = (refusal: EgressRefused, client: string, who: CallerFields) =>
    Effect.logWarning("Gateway refused a request", {
      reason: refusal.reason,
      host: refusal.host,
      port: refusal.port,
      client,
      ...who,
    });

  /** Resolves an allowed host and returns the first address, or refuses when any address is private. */
  const resolve = Effect.fn("EgressProxy.resolve")(function* (permitted: EgressPermitted) {
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

  const decide = (host: string, port: number): Effect.Effect<EgressPermitted, EgressRefused> => {
    const decision = settings.egress.decide(host, port);
    return decision._tag === "EgressRefused" ? Effect.fail(decision) : Effect.succeed(decision);
  };

  /** Where a request for `host` on `port` goes: the reverse proxy for the gateway's own names, else the resolved allowed host. */
  const destination = (
    host: string,
    port: number,
  ): Effect.Effect<Destination, EgressRefused | Unresolvable> =>
    ownHosts.has(host.toLowerCase()) && port === 80
      ? Effect.succeed({ address: gateway.host, port: gateway.port, kind: "gateway" })
      : decide(host, port).pipe(
          Effect.flatMap(resolve),
          Effect.map((address) => ({ address, port, kind: "egress" })),
        );

  const openTunnel = (address: string, port: number, host: string) =>
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

  /** Copies bytes both ways until either side closes, then closes both. */
  const splice = (client: Duplex, upstream: Socket) =>
    Effect.callback<void>((resume) => {
      const close = () => {
        client.destroy();
        upstream.destroy();
        resume(Effect.void);
      };
      client.on("error", close).on("close", close);
      upstream.on("error", close).on("close", close);
      client.pipe(upstream);
      upstream.pipe(client);
      return Effect.sync(close);
    });

  /** Refuses a tunnel after its `200 Connection Established`, when closing the connection is all that is left. */
  const closeRefused = (client: Duplex, refusal: TunnelRefused) => {
    if (refusal.reason === "not-tls") client.destroy();
    else client.end(UNRECOGNIZED_NAME_ALERT);
  };

  const tunnel = Effect.fn("EgressProxy.tunnel")(function* (
    request: IncomingMessage,
    client: Duplex,
    head: Buffer,
  ) {
    const from = request.socket.remoteAddress ?? "unknown";
    const who = yield* caller(request.headers["proxy-authorization"]);
    const authority = parseAuthority(request.url ?? "");
    if (Option.isNone(authority)) {
      client.end(statusLine(400, "Bad Request", "Expected CONNECT host:port\n", Option.none()));
      return yield* Effect.logWarning("Gateway refused a request", {
        reason: "malformed-connect",
        client: from,
        ...who,
      });
    }
    const { host, port } = authority.value;
    yield* Effect.annotateCurrentSpan({ host, port });

    if (ownHosts.has(comparableHost(host)) && port === 80) {
      const opened = yield* openTunnel(gateway.host, gateway.port, host).pipe(Effect.result);
      if (opened._tag === "Failure") {
        client.end(
          statusLine(
            502,
            "Bad Gateway",
            "usine gateway: the reverse proxy could not be reached.\n",
            Option.none(),
          ),
        );
        return yield* Effect.logError("The gateway's reverse proxy could not be reached", {
          host,
          port,
          client: from,
          ...who,
          error: opened.failure._tag,
        });
      }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) opened.success.write(head);
      yield* Effect.logInfo("Opened an egress tunnel", {
        host,
        port,
        destination: "gateway",
        client: from,
        ...who,
      });
      return yield* splice(client, opened.success);
    }

    const decision = settings.egress.decide(host, port);
    // Plain HTTP goes through the absolute-form relay, which sees the host it is sent to; a tunnel on another port could carry anything.
    if (decision._tag === "EgressRefused" || port !== 443) {
      const refused =
        decision._tag === "EgressRefused"
          ? decision
          : new EgressRefused({ host, port, reason: "port-not-allowed" });
      client.end(
        statusLine(
          403,
          "Forbidden",
          `usine gateway: ${host}:${port} is refused (${refused.reason}).\n`,
          Option.some(refused.reason),
        ),
      );
      return yield* logRefusal(refused, from, who);
    }

    // The client sends its ClientHello only after this line; no upstream connection exists until its server name is checked.
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const opened = yield* clientHello(client, head).pipe(
      Effect.flatMap((hello) => pinnedServerName(host, hello)),
      Effect.flatMap(({ buffered, serverName }) =>
        resolve(decision).pipe(
          Effect.catchTag("EgressRefused", (refused) =>
            Effect.fail(
              new TunnelRefused({
                reason: "private-address",
                detail: `${refused.host} resolves to a private address`,
                serverName: Option.some(serverName),
              }),
            ),
          ),
          Effect.flatMap((address) => openTunnel(address, port, decision.host)),
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
          host,
          port,
          serverName: Option.getOrElse(failure.serverName, () => "none"),
          detail: failure.detail,
          client: from,
          ...who,
        });
      }
      client.destroy();
      return yield* Effect.logError("An allowed egress host could not be reached", {
        host,
        port,
        client: from,
        ...who,
        error: failure._tag,
      });
    }
    const { upstream, buffered, serverName } = opened.success;
    upstream.write(buffered);
    yield* Effect.logInfo("Opened an egress tunnel", {
      host,
      port,
      serverName,
      destination: "egress",
      client: from,
      ...who,
    });
    yield* splice(client, upstream);
  });

  const relay = Effect.fn("EgressProxy.relay")(function* (
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const from = request.socket.remoteAddress ?? "unknown";
    const who = yield* caller(request.headers["proxy-authorization"]);
    const url = Option.liftThrowable(() => new URL(request.url ?? ""))().pipe(
      Option.filter((parsed) => parsed.protocol === "http:"),
    );
    if (Option.isNone(url)) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("usine gateway: the forward proxy takes CONNECT, or an absolute http:// URL.\n");
      return yield* Effect.logWarning("Gateway refused a request", {
        reason: "not-a-proxy-request",
        client: from,
        ...who,
      });
    }
    const port = url.value.port === "" ? 80 : Number(url.value.port);
    const host = url.value.hostname.replace(/^\[(.*)\]$/u, "$1");
    yield* Effect.annotateCurrentSpan({ host, port });
    const forwarded = endToEndHeaders(Headers.fromInput(request.headers));

    /**
     * Sends the request to `target` and copies the response back, until the
     * upstream response ends or the client closes its connection. A client
     * that leaves mid-download or mid-upload has its upstream connection
     * destroyed at once, so no upstream waits on a response nobody reads or
     * on request bytes that will never arrive. An upstream that cannot be
     * reached, or whose response ends early, fails as `Unreachable` once the
     * client's response is destroyed or answered 502.
     */
    const copy = (target: Destination, headers: Headers.Headers) =>
      Effect.callback<RelayEnd, Unreachable>((resume) => {
        let settled = false;
        const settle = (end: Effect.Effect<RelayEnd, Unreachable>) => {
          settled = true;
          resume(end);
        };
        const fail = (error: Error) => {
          if (settled) return;
          if (response.headersSent) response.destroy();
          else {
            response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
            response.end();
          }
          settle(Effect.fail(new Unreachable({ host, port, message: error.message })));
        };
        const outgoing = httpRequest(
          {
            host: target.address,
            port: target.port,
            method: request.method,
            path: `${url.value.pathname}${url.value.search}`,
            headers: { ...headers, host: url.value.host },
            setHost: false,
          },
          (incoming) => {
            const status = incoming.statusCode ?? 502;
            response.writeHead(status, {
              ...endToEndHeaders(Headers.fromInput(incoming.headers)),
            });
            incoming.once("error", fail);
            incoming.once("close", () => {
              if (!incoming.complete) fail(new Error("The upstream response ended prematurely"));
            });
            incoming.once("end", () => settle(Effect.succeed(RelayEnd.Relayed({ status }))));
            incoming.pipe(response);
          },
        );
        // `close` also follows a finished response, which has settled the relay already; before that, it means the client left.
        response.once("close", () => {
          if (settled) return;
          outgoing.destroy();
          settle(
            Effect.succeed(
              RelayEnd.Abandoned({
                status: response.headersSent ? Option.some(response.statusCode) : Option.none(),
              }),
            ),
          );
        });
        outgoing.once("error", fail);
        request.pipe(outgoing);
        return Effect.sync(() => outgoing.destroy());
      });

    const relayed = yield* destination(host, port).pipe(
      Effect.flatMap((target) =>
        // The reverse proxy needs the caller token; a host outside the gateway must never see it.
        (target.kind === "gateway"
          ? Effect.succeed(forwarded)
          : callers.withoutCallerTokens(forwarded)
        ).pipe(Effect.map((headers) => ({ target, headers }))),
      ),
      Effect.flatMap(({ target, headers }) =>
        copy(target, headers).pipe(Effect.map((end) => ({ end, kind: target.kind }))),
      ),
      Effect.result,
    );
    if (relayed._tag === "Success") {
      const fields = {
        host,
        port,
        destination: relayed.success.kind,
        method: request.method ?? "GET",
        client: from,
        ...who,
      };
      return yield* Match.valueTags(relayed.success.end, {
        Relayed: ({ status }) =>
          Effect.logInfo("Relayed a plain HTTP request", { ...fields, status }),
        Abandoned: ({ status }) =>
          Effect.logInfo("The client abandoned a relayed request", {
            ...fields,
            status: Option.getOrElse(status, () => "none"),
          }),
      });
    }
    const failure = relayed.failure;
    if (failure._tag === "EgressRefused") {
      response.writeHead(403, {
        "content-type": "text/plain; charset=utf-8",
        [REFUSAL_HEADER]: failure.reason,
      });
      response.end(`usine gateway: ${host}:${port} is refused (${failure.reason}).\n`);
      return yield* logRefusal(failure, from, who);
    }
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      response.end(`usine gateway: ${host} could not be reached.\n`);
    }
    yield* Effect.logError("An allowed egress host could not be reached", {
      host,
      port,
      client: from,
      ...who,
      error: failure._tag,
    });
  });

  const server = createServer({ requestTimeout: 0 });
  const run = (effect: Effect.Effect<void>) =>
    Fiber.runIn(Effect.runForkWith(context)(effect), scope);
  server.on("connect", (request: IncomingMessage, client: Duplex, head: Buffer) => {
    client.on("error", () => client.destroy());
    run(tunnel(request, client, head));
  });
  server.on("request", (request, response) => run(relay(request, response)));

  yield* Effect.acquireRelease(
    Effect.callback<void, EgressProxyListenError>((resume) => {
      server.once("error", (error) =>
        resume(
          Effect.fail(
            new EgressProxyListenError({
              host: listener.host,
              port: listener.port,
              message: error.message,
            }),
          ),
        ),
      );
      server.listen(listener.port, listener.host, () => resume(Effect.void));
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  const bound =
    address === null || Predicate.isString(address)
      ? listener
      : { host: address.address, port: address.port };
  yield* Effect.logInfo("The egress proxy is listening", bound);
  return bound;
});
