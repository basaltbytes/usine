import { createServer, type Socket } from "node:net";
import { Effect, Fiber, Predicate, Schema } from "effect";
import type { Listener } from "../environment.ts";
import { egressTunnels, TunnelEntry } from "./tunnel.ts";

/** The transparent listener could not listen on its address. */
export class TransparentListenError extends Schema.TaggedError<TransparentListenError>()(
  "TransparentListenError",
  { host: Schema.String, port: Schema.Int, message: Schema.String },
) {}

/**
 * Serves the transparent path for clients that ignore `HTTPS_PROXY`. The
 * gateway's dnsmasq answers each name the allowlist permits on port 443
 * with the gateway's private address, so such a client connects here with a
 * TLS ClientHello that names the host it wants. The connection goes through the same TLS
 * relay as a CONNECT tunnel (`egressTunnels`), which opens it only when the
 * server name is on the allowlist and refuses a ClientHello that names
 * another host, names none, or is not TLS, with the same log fields.
 */
export const serveTransparent = Effect.fn("Transparent.serve")(function* (listener: Listener) {
  const tunnels = yield* egressTunnels;
  const scope = yield* Effect.scope;
  const context = yield* Effect.context<never>();
  const open = new Set<Socket>();
  const server = createServer((client) => {
    open.add(client);
    client.once("close", () => open.delete(client));
    client.on("error", () => client.destroy());
    Fiber.runIn(
      Effect.runForkWith(context)(
        tunnels.relay(client, Buffer.alloc(0), TunnelEntry.Transparent(), {
          client: client.remoteAddress ?? "unknown",
          caller: "none",
        }),
      ),
      scope,
    );
  });

  yield* Effect.acquireRelease(
    Effect.callback<void, TransparentListenError>((resume) => {
      server.once("error", (error) =>
        resume(
          Effect.fail(
            new TransparentListenError({
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
        for (const client of open) client.destroy();
      }),
  );
  const address = server.address();
  const bound =
    address === null || Predicate.isString(address)
      ? listener
      : { host: address.address, port: address.port };
  yield* Effect.logInfo("The transparent listener is listening", bound);
  return bound;
});
