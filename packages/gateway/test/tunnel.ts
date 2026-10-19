import { request } from "node:http";
import type { Socket } from "node:net";
import { connect } from "node:tls";
import { Effect, Option } from "effect";
import type { Listener } from "../src/node/node.ts";

/** What a client saw when it used a tunnel: the CONNECT status if it was not 200, or how the connection inside went. */
type TunnelOutcome = "connected" | "refused" | "closed" | `status ${number}`;

/** Sends `CONNECT authority` and hands the tunnel's socket to `inside` once the proxy answers 200. */
const tunnel = (
  proxy: Listener,
  authority: string,
  inside: (socket: Socket, done: (outcome: TunnelOutcome) => void) => void,
) =>
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

/**
 * Starts TLS inside a tunnel with `servername` in its ClientHello, or with
 * none, and verifies the server's certificate against Node's CAs.
 */
export const tlsThroughTunnel = (
  proxy: Listener,
  authority: string,
  servername: Option.Option<string>,
) =>
  tunnel(proxy, authority, (socket, done) => {
    // With an IP address as `host` and an empty `servername`, Node sends no server name at all.
    const secure = connect({
      socket,
      host: "127.0.0.1",
      servername: Option.getOrElse(servername, () => ""),
    });
    secure.once("secureConnect", () => {
      secure.destroy();
      done("connected");
    });
    secure.once("error", () => {
      secure.destroy();
      done("refused");
    });
    secure.once("close", () => done("refused"));
  });

/** Writes `bytes` into a tunnel and reports when the proxy closes it. */
export const rawThroughTunnel = (proxy: Listener, authority: string, bytes: string) =>
  tunnel(proxy, authority, (socket, done) => {
    socket.on("error", () => socket.destroy());
    socket.once("close", () => done("closed"));
    socket.write(bytes);
  });

/** Closes a tunnel once the proxy answers 200, before writing anything into it, and reports when the proxy closes it too. */
export const abandonedTunnel = (proxy: Listener, authority: string) =>
  tunnel(proxy, authority, (socket, done) => {
    socket.on("error", () => socket.destroy());
    socket.once("close", () => done("closed"));
    socket.end();
  });

/** Opens a tunnel and keeps it open without writing anything, so the proxy waits for its ClientHello. */
export const silentTunnel = (proxy: Listener, authority: string) =>
  Effect.callback<Socket>((resume) => {
    const outgoing = request({
      host: proxy.host,
      port: proxy.port,
      method: "CONNECT",
      path: authority,
    });
    outgoing.once("connect", (response, socket) => {
      socket.on("error", () => socket.destroy());
      if (response.statusCode === 200) return resume(Effect.succeed(socket));
      socket.destroy();
      resume(Effect.die(new Error(`CONNECT answered ${response.statusCode ?? 0}`)));
    });
    outgoing.once("error", (error) => resume(Effect.die(error)));
    outgoing.end();
  });
