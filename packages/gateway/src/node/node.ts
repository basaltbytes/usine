import { createServer } from "node:http";
import { NodeFileSystem, NodeHttpClient, NodeHttpServer } from "@effect/platform-node";
import { Config, ConfigProvider, Context, Effect, Layer, Stream } from "effect";
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
import { gatewayServicesWithAttachments } from "../gateway.ts";
import { Attachments } from "../attachment/store.ts";
import type { AttachmentPersistenceError } from "../attachment/attachment.ts";
import { fileAttachmentsLayer } from "./attachments.ts";
import { trackConnections } from "./connections.ts";
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

/** The bound addresses of the gateway's three servers, with any port 0 replaced by the assigned port. */
export class GatewayAddresses extends Context.Service<
  GatewayAddresses,
  {
    /** The bound reverse-proxy address with any requested port zero replaced by the assigned port. */
    readonly proxy: Listener;
    /** The bound forward-proxy address with any requested port zero replaced by the assigned port. */
    readonly egress: Listener;
    /** The bound admin API address with any requested port zero replaced by the assigned port. */
    readonly admin: Listener;
  }
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
  const http = createServer({ requestTimeout: 0 });
  const closeConnections = trackConnections(http);
  const server = yield* NodeHttpServer.make(() => http, {
    ...listener,
    disablePreemptiveShutdown: true,
  });
  yield* server.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const response = yield* proxy.handle;
      if (response.body._tag !== "Stream") return response;
      // The server destroys a response whose body fails after its headers, so the Worker sees a
      // partial download or model response as incomplete.
      const body = response.body.stream.pipe(
        Stream.onError(() =>
          Effect.logError("The reverse proxy response body failed", {
            host: request.headers.host,
            method: request.method,
            path: request.url.split("?")[0],
            error: "UpstreamBodyFailure",
          }),
        ),
      );
      return HttpServerResponse.setBody(
        response,
        HttpBody.stream(body, response.body.contentType, response.body.contentLength),
      );
    }),
  );
  yield* Effect.addFinalizer(closeConnections);
  const bound = boundTo(server.address, listener);
  yield* Effect.logInfo("The gateway proxy is listening", bound);
  return bound;
});

const serveAdmin = Effect.fn("GatewayNode.serveAdmin")(function* (listener: Listener) {
  const http = createServer();
  const closeConnections = trackConnections(http);
  const server = yield* NodeHttpServer.make(() => http, {
    ...listener,
    disablePreemptiveShutdown: true,
  });
  yield* Layer.build(
    HttpRouter.serve(adminRoutes, { disableListenLog: true }).pipe(
      Layer.provide(Layer.succeed(HttpServer.HttpServer)(server)),
      Layer.provide(NodeHttpServer.layerHttpServices),
    ),
  );
  yield* Effect.addFinalizer(closeConnections);
  const bound = boundTo(server.address, listener);
  yield* Effect.logInfo("The gateway admin API is listening", bound);
  return bound;
});

/**
 * The gateway on Node: the reverse proxy, forward proxy, and admin API on their listeners,
 * sharing one attachment store, caller token signer, settings, and ChatGPT logins. Upstream
 * requests use undici, which doesn't change `content-encoding`, so compressed bodies pass
 * through unchanged. ChatGPT logins read and write their auth files with Node's file system.
 * Closing the layer closes listeners and active client connections, including tunnels (ADR 0027).
 *
 * @param listeners - Addresses to bind. Port zero selects an available port.
 * @param attachments - The shared attachment layer; defaults to an empty in-memory store.
 * @returns A scoped layer with gateway services and the bound addresses. Fails if attachment
 * restoration or a listener fails.
 */
export const gatewayLayer = (
  listeners: GatewayListeners,
  attachments: Layer.Layer<
    Attachments,
    AttachmentPersistenceError,
    GatewaySettings
  > = Attachments.layer,
) =>
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
    Layer.provideMerge(gatewayServicesWithAttachments(attachments)),
    Layer.provide(Layer.mergeAll(NodeHttpClient.layerUndici, NodeFileSystem.layer)),
    // No automatic HTTP span records the incoming headers. Named Gateway spans record safe fields
    // without incoming credentials.
    Layer.provide(Layer.succeed(HttpMiddleware.TracerDisabledWhen)(() => true)),
  );

/**
 * The gateway configured from its environment files, the process environment, and its
 * allowlist file, as run by the `usine-gateway` command. On SIGHUP, reloads the egress
 * allowlist and LLM providers with `GatewayReload`. Restores encrypted attachments before
 * opening listeners, using `STATE_DIRECTORY` or `/var/lib/usine-gateway` and the caller key.
 * A corrupt snapshot or changed key fails startup without replacing the snapshot (ADR 0027).
 */
export const gatewayFromEnvironment = Layer.unwrap(
  Effect.gen(function* () {
    const base = yield* ConfigProvider.ConfigProvider;
    const source = yield* readSettingsSource(base);
    const started = yield* readStartupSettings(source);
    const directory = yield* Config.String("STATE_DIRECTORY")
      .pipe(Config.withDefault("/var/lib/usine-gateway"))
      .parse(source.provider);
    const attachments = fileAttachmentsLayer(directory);
    return reloadOnHangup.pipe(
      Layer.provideMerge(gatewayReloadLayer(started, base)),
      Layer.provideMerge(gatewayLayer(started.listeners, attachments)),
      Layer.provide(Layer.succeed(GatewaySettings)(started.settings)),
    );
  }),
);
