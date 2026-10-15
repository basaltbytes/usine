import { request } from "node:http";
import { connect as connectTcp, type Socket } from "node:net";
import { connect } from "node:tls";
import { Effect, Option } from "effect";
import type { Listener } from "../src/node/node.ts";

/** What a client saw when it used a tunnel: the CONNECT status if it was not 200, or how the connection inside went. */
type TunnelOutcome = "connected" | "refused" | "closed" | `status ${number}`;

/** What a client does with a socket once it reaches the gateway, and how it reports the outcome. */
type Inside = (socket: Socket, done: (outcome: TunnelOutcome) => void) => void;

/** Sends `CONNECT authority` and hands the tunnel's socket to `inside` once the proxy answers 200. */
const tunnel = (proxy: Listener, authority: string, inside: Inside) =>
  Effect.callback<TunnelOutcome>((resume) => {
    const done = (outcome: TunnelOutcome) => resume(Effect.succeed(outcome));
    const outgoing = request({
      host: proxy.host,
      port: proxy.port,
      method: "CONNECT",
      path: authority,
    });
    outgoing.once("connect", (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        return done(`status ${response.statusCode ?? 0}`);
      }
      inside(socket, done);
    });
    outgoing.once("error", (error) => resume(Effect.die(error)));
    outgoing.end();
  });

/** Connects straight to `listener`, as a client that ignores proxy variables does once DNS sent it there, and hands the socket to `inside`. */
const direct = (listener: Listener, inside: Inside) =>
  Effect.callback<TunnelOutcome>((resume) => {
    const socket = connectTcp(listener.port, listener.host);
    socket.once("error", (error) => resume(Effect.die(error)));
    socket.once("connect", () => inside(socket, (outcome) => resume(Effect.succeed(outcome))));
  });

/**
 * Starts TLS with `servername` in its ClientHello, or with none, verifies
 * the server's certificate against Node's CAs, and leaves the connection to
 * `connected`, which closes it.
 */
const tls =
  (servername: Option.Option<string>, connected: (secure: Socket) => void): Inside =>
  (socket, done) => {
    // With an IP address as `host` and an empty `servername`, Node sends no server name at all.
    const secure = connect({
      socket,
      host: "127.0.0.1",
      servername: Option.getOrElse(servername, () => ""),
    });
    secure.once("secureConnect", () => {
      connected(secure);
      done("connected");
    });
    secure.once("error", () => {
      secure.destroy();
      done("refused");
    });
    secure.once("close", () => done("refused"));
  };

const closeAtOnce = (secure: Socket) => secure.destroy();

/** Writes `bytes` and reports when the gateway closes the connection. */
const raw =
  (bytes: string): Inside =>
  (socket, done) => {
    socket.on("error", () => socket.destroy());
    socket.once("close", () => done("closed"));
    socket.write(bytes);
  };

/** Starts TLS inside a CONNECT tunnel with `servername` in its ClientHello, or with none. */
export const tlsThroughTunnel = (
  proxy: Listener,
  authority: string,
  servername: Option.Option<string>,
) => tunnel(proxy, authority, tls(servername, closeAtOnce));

/** Writes `bytes` into a CONNECT tunnel and reports when the proxy closes it. */
export const rawThroughTunnel = (proxy: Listener, authority: string, bytes: string) =>
  tunnel(proxy, authority, raw(bytes));

/**
 * Starts TLS straight at the transparent listener with `servername` in its
 * ClientHello, or with none. `connected` gets the TLS connection once the
 * handshake succeeds and must close it; by default it closes at once.
 */
export const tlsDirect = (
  listener: Listener,
  servername: Option.Option<string>,
  connected: (secure: Socket) => void = closeAtOnce,
) => direct(listener, tls(servername, connected));

/** Writes `bytes` straight to the transparent listener and reports when it closes the connection. */
export const rawDirect = (listener: Listener, bytes: string) => direct(listener, raw(bytes));
