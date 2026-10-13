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
import { Effect, Fiber, Option, Predicate, Schema } from "effect";
import { Headers } from "effect/unstable/http";
import { tokenFromAuthorization, CallerTokens } from "../caller/caller.ts";
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

/** The upstream connection could not be opened. */
class Unreachable extends Schema.TaggedError<Unreachable>()("Unreachable", {
  host: Schema.String,
  port: Schema.Int,
  message: Schema.String,
}) {}

/** The caller of a forward proxy request as it appears in logs. */
type CallerFields = { readonly worker: WorkerName } | { readonly caller: "none" | "invalid-token" };

/** Where the proxy connects for a request: the gateway's reverse proxy, or an allowed host's address. */
interface Destination {
  readonly address: string;
  readonly port: number;
  readonly kind: "gateway" | "egress";
}

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
 * allowlisted hosts: `CONNECT host:port` for HTTPS, and absolute-form
 * requests (`GET http://host/...`) for plain HTTP mirrors such as apt. The
 * proxy resolves each name itself and refuses one that resolves to a private
 * address, so an allowlisted name cannot be pointed at the gateway's own
 * network. A client that sends every request through a proxy, as Claude Code
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
    const opened = yield* destination(host, port).pipe(
      Effect.flatMap((target) =>
        openTunnel(target.address, target.port, host).pipe(
          Effect.map((socket) => ({ socket, kind: target.kind })),
        ),
      ),
      Effect.result,
    );
    if (opened._tag === "Failure") {
      const failure = opened.failure;
      if (failure._tag === "EgressRefused") {
        client.end(
          statusLine(
            403,
            "Forbidden",
            `usine gateway: ${host}:${port} is refused (${failure.reason}).\n`,
            Option.some(failure.reason),
          ),
        );
        return yield* logRefusal(failure, from, who);
      }
      client.end(
        statusLine(
          502,
          "Bad Gateway",
          `usine gateway: ${host}:${port} could not be reached.\n`,
          Option.none(),
        ),
      );
      return yield* Effect.logError("An allowed egress host could not be reached", {
        host,
        port,
        client: from,
        ...who,
        error: failure._tag,
      });
    }
    const { socket: upstream, kind } = opened.success;
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    yield* Effect.logInfo("Opened an egress tunnel", {
      host,
      port,
      destination: kind,
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
    const relayed = yield* destination(host, port).pipe(
      Effect.flatMap((target) =>
        Effect.callback<number, Unreachable>((resume) => {
          const outgoing = httpRequest(
            {
              host: target.address,
              port: target.port,
              method: request.method,
              path: `${url.value.pathname}${url.value.search}`,
              headers: {
                ...endToEndHeaders(Headers.fromInput(request.headers)),
                host: url.value.host,
              },
              setHost: false,
            },
            (incoming) => {
              const status = incoming.statusCode ?? 502;
              response.writeHead(status, {
                ...endToEndHeaders(Headers.fromInput(incoming.headers)),
              });
              incoming.pipe(response);
              incoming.once("end", () => resume(Effect.succeed(status)));
            },
          );
          outgoing.once("error", (error) => {
            if (!response.headersSent)
              response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
            response.end();
            resume(Effect.fail(new Unreachable({ host, port, message: error.message })));
          });
          request.pipe(outgoing);
          return Effect.sync(() => outgoing.destroy());
        }).pipe(Effect.map((status) => ({ status, kind: target.kind }))),
      ),
      Effect.result,
    );
    if (relayed._tag === "Success")
      return yield* Effect.logInfo("Relayed a plain HTTP request", {
        host,
        port,
        destination: relayed.success.kind,
        method: request.method ?? "GET",
        status: relayed.success.status,
        client: from,
        ...who,
      });
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
