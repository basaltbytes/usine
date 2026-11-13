import { Context, Effect, Layer, Ref, type Scope, type PlatformError } from "effect";
import {
  HttpMiddleware,
  HttpServer,
  type HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { NodeHttpServer } from "@effect/platform-node";
// The Node server adapter requires the native HTTP server constructor.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createServer } from "node:http";
import { type Port, portInUse, SERVER_HOST, serverStartError } from "./cli.ts";

type HttpHandler = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  HttpServerError.HttpServerError | PlatformError.PlatformError,
  HttpServerRequest.HttpServerRequest | Scope.Scope
>;

/**
 * Serves the version during startup. `install` serves the runtime routes on the same listener
 * until its scope closes, then restores the startup responses.
 */
export const startupListener = Effect.fnUntraced(function* (version: string) {
  const server = yield* HttpServer.HttpServer;
  const starting: HttpHandler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method === "GET" && request.url.split("?")[0] === "/api/version")
      return HttpServerResponse.jsonUnsafe(version);
    return HttpServerResponse.jsonUnsafe(
      { error: "Starting", message: "Startup recovery is in progress." },
      {
        status: 503,
        headers: { "retry-after": "1" },
      },
    );
  });
  const handler = yield* Ref.make(starting);
  yield* server.serve(Effect.flatten(Ref.get(handler)), HttpMiddleware.logger);
  yield* Effect.logInfo("HTTP listener ready; startup recovery can continue", { version });
  return {
    install: (next: HttpHandler) =>
      Effect.acquireRelease(Ref.set(handler, next), () =>
        Ref.set(handler, starting).pipe(
          Effect.andThen(Effect.logInfo("HTTP routes removed; startup responses restored")),
        ),
      ),
  };
});

export type StartupListener = Effect.Success<ReturnType<typeof startupListener>>;

/**
 * Listens on `port` at the server host with the startup responses of `startupListener`, so every
 * request gets an answer from the moment the port accepts connections. Fails with
 * `PortInUseError` when another process holds the port. The listener closes with the scope.
 */
export const listenForStartup = Effect.fnUntraced(function* (port: Port, version: string) {
  const http = yield* Layer.build(
    NodeHttpServer.layer(createServer, { host: SERVER_HOST, port }),
  ).pipe(
    Effect.mapError((error) => serverStartError(port, error)),
    Effect.catchTag("PortInUseError", ({ port }) => portInUse(port)),
  );
  return yield* startupListener(version).pipe(
    Effect.provideService(HttpServer.HttpServer, Context.get(http, HttpServer.HttpServer)),
  );
});
