import { createServer } from "node:http";
import {
  NodeFileSystem,
  NodeHttpClient,
  NodeHttpServer,
  NodeHttpServerRequest,
} from "@effect/platform-node";
import { ConfigProvider, Context, Effect, Layer, Stream } from "effect";
import {
  HttpMiddleware,
  HttpBody,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { NetAddress } from "effect/net";
import { adminRoutes } from "../admin/server.ts";
import { gatewayServices } from "../gateway.ts";
import { GatewayProxy } from "../proxy/proxy.ts";
import { GatewaySettings } from "../settings.ts";
import { serveEgressProxy } from "./egress-proxy.ts";
import {
  type GatewayListeners,
  type Listener,
  readSettingsSource,
  readStartupSettings,
} from "./environment.ts";
import { gatewayReloadLayer, reloadOnHangup } from "./reload.ts";

export {
  ConflictingProviderCredentials,
  DEFAULT_EGRESS_ALLOWLIST_PATH,
  EnvironmentFileError,
  type GatewayListeners,
  type Listener,
  listenersFromEnvironment,
  settingsFromEnvironment,
} from "./environment.ts";
export { EgressProxyListenError } from "./egress-proxy.ts";
export { GatewayReload } from "./reload.ts";

/** The bound addresses of the Gateway's three servers, with any port 0 replaced by the assigned port. */
export class GatewayAddresses extends Context.Service<
  GatewayAddresses,
  { readonly proxy: Listener; readonly egress: Listener; readonly admin: Listener }
>()("@usine/gateway/node/GatewayAddresses") {}

const boundTo = (address: NetAddress.SocketAddress, requested: Listener): Listener =>
  address._tag === "UnixPathAddress"
    ? requested
    : { host: NetAddress.formatHost(address), port: address.port };

/** Returns an address this process can connect to for `listener`, which may be bound to all interfaces. */
const reachable = (listener: Listener): Listener =>
  listener.host === "0.0.0.0" || listener.host === "::"
    ? { host: "127.0.0.1", port: listener.port }
    : listener;

const serveProxy = Effect.fn("GatewayNode.serveProxy")(function* (listener: Listener) {
  const proxy = yield* GatewayProxy;
  // A git push or a long model response can exceed Node's default request timeout.
  const server = yield* NodeHttpServer.make(() => createServer({ requestTimeout: 0 }), listener);
  yield* server.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const response = yield* proxy.handle;
      if (response.body._tag !== "Stream") return response;
      // effect 4.0.0-rc.111 ends a failed stream normally after sending headers. Destroying it first keeps a
      // partial download or model response from looking complete to the Worker.
      const body = response.body.stream.pipe(
        Stream.onError(() =>
          Effect.gen(function* () {
            yield* Effect.logError("The reverse proxy response body failed", {
              host: request.headers.host,
              method: request.method,
              path: request.url.split("?")[0],
              error: "UpstreamBodyFailure",
            });
            NodeHttpServerRequest.toServerResponse(request).destroy();
          }).pipe(Effect.uninterruptible),
        ),
      );
      return HttpServerResponse.setBody(
        response,
        HttpBody.stream(body, response.body.contentType, response.body.contentLength),
      );
    }),
  );
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
 * The Gateway on Node: the reverse proxy, forward proxy, and admin API on their listeners,
 * sharing one attachment store, caller token signer, settings, and ChatGPT logins. Upstream
 * requests use undici, which doesn't change `content-encoding`, so compressed bodies pass
 * through unchanged. ChatGPT logins read and write their auth files with Node's file system.
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
    Layer.provideMerge(gatewayServices),
    Layer.provide(Layer.mergeAll(NodeHttpClient.layerUndici, NodeFileSystem.layer)),
    // effect 4.0.0-rc.111 reads header redaction settings after the request fiber may have cleared its
    // context, so automatic HTTP spans are disabled. Named Gateway spans still record safe fields
    // without incoming credentials.
    Layer.provide(Layer.succeed(HttpMiddleware.TracerDisabledWhen)(() => true)),
  );

/**
 * The Gateway configured from its environment files, the process environment, and its
 * allowlist file, as run by the `usine-gateway` command. On SIGHUP, reloads the egress
 * allowlist and LLM providers with `GatewayReload`.
 */
export const gatewayFromEnvironment = Layer.unwrap(
  Effect.gen(function* () {
    const base = yield* ConfigProvider.ConfigProvider;
    const started = yield* readStartupSettings(yield* readSettingsSource(base));
    return reloadOnHangup.pipe(
      Layer.provideMerge(gatewayReloadLayer(started, base)),
      Layer.provideMerge(gatewayLayer(started.listeners)),
      Layer.provide(Layer.succeed(GatewaySettings)(started.settings)),
    );
  }),
);
