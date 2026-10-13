import { createServer } from "node:http";
import { NodeHttpClient, NodeHttpServer } from "@effect/platform-node";
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { adminRoutes } from "../admin/server.ts";
import { Attachments } from "../attachment/store.ts";
import { CallerTokens } from "../caller/caller.ts";
import { GatewayProxy } from "../proxy/proxy.ts";
import { serveEgressProxy } from "./egress-proxy.ts";
import {
  type GatewayListeners,
  type Listener,
  listenersFromEnvironment,
  settingsFromEnvironment,
} from "./environment.ts";

export {
  ConflictingAnthropicCredentials,
  DEFAULT_EGRESS_ALLOWLIST_PATH,
  type GatewayListeners,
  type Listener,
  listenersFromEnvironment,
  settingsFromEnvironment,
} from "./environment.ts";
export { EgressProxyListenError } from "./egress-proxy.ts";

/** The addresses the gateway's three servers are bound to, with any port 0 replaced by the port the system chose. */
export class GatewayAddresses extends Context.Service<
  GatewayAddresses,
  { readonly proxy: Listener; readonly egress: Listener; readonly admin: Listener }
>()("@usine/gateway/node/GatewayAddresses") {}

const boundTo = (address: HttpServer.Address, requested: Listener): Listener =>
  address._tag === "TcpAddress" ? { host: address.hostname, port: address.port } : requested;

/** An address this process can connect to for a listener, which may be bound to every interface. */
const reachable = (listener: Listener): Listener =>
  listener.host === "0.0.0.0" || listener.host === "::"
    ? { host: "127.0.0.1", port: listener.port }
    : listener;

const serveProxy = Effect.fn("GatewayNode.serveProxy")(function* (listener: Listener) {
  const proxy = yield* GatewayProxy;
  // A git push or a long model response may take longer than Node's default request timeout.
  const server = yield* NodeHttpServer.make(() => createServer({ requestTimeout: 0 }), listener);
  yield* server.serve(proxy.handle);
  const bound = boundTo(server.address, listener);
  yield* Effect.logInfo("The gateway proxy is listening", bound);
  return bound;
});

const serveAdmin = Effect.fn("GatewayNode.serveAdmin")(function* (listener: Listener) {
  const server = yield* NodeHttpServer.make(() => createServer(), listener);
  yield* Layer.build(
    HttpRouter.serve(adminRoutes, { disableListenLog: true }).pipe(
      Layer.provide(Layer.succeed(HttpServer.HttpServer)(server)),
      Layer.provide(NodeHttpServer.layerHttpServices),
    ),
  );
  const bound = boundTo(server.address, listener);
  yield* Effect.logInfo("The gateway admin API is listening", bound);
  return bound;
});

/**
 * The gateway on Node: the reverse proxy, the forward proxy, and the admin
 * API on their listeners, sharing one attachment store and caller token
 * signer. Upstream requests use undici, which leaves `content-encoding`
 * alone, so compressed bodies pass through byte for byte.
 */
export const gatewayLayer = (listeners: GatewayListeners) =>
  Layer.effect(
    GatewayAddresses,
    Effect.gen(function* () {
      const proxy = yield* serveProxy(listeners.proxy);
      const egress = yield* serveEgressProxy(listeners.egress, reachable(proxy));
      const admin = yield* serveAdmin(listeners.admin);
      return { proxy, egress, admin };
    }),
  ).pipe(
    Layer.provide(GatewayProxy.layer),
    Layer.provideMerge(Layer.mergeAll(Attachments.layer, CallerTokens.layer)),
    Layer.provide(NodeHttpClient.layerUndici),
  );

/** The gateway configured from the environment and its allowlist file, as the `usine-gateway` command runs it. */
export const gatewayFromEnvironment = Layer.unwrap(
  Effect.gen(function* () {
    return gatewayLayer(yield* listenersFromEnvironment);
  }),
).pipe(Layer.provide(settingsFromEnvironment));
