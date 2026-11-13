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

// Startup responses close the connection, so a client that keeps polling can't hold the server
// open after a failed startup.
const startupHeaders = { connection: "close" };

const startupResponse = (message: string) =>
  HttpServerResponse.jsonUnsafe(
    { error: "Starting", message },
    {
      status: 503,
      headers: { ...startupHeaders, "retry-after": "1" },
    },
  );

/**
 * Answers every request with HTTP 503 and `Retry-After: 1` until `started` runs. From then on,
 * `GET /api/version` returns `version`, and `install` serves the routes it receives on the same
 * listener until its scope closes, then restores the startup responses.
 */
export const startupListener = Effect.fnUntraced(function* (version: string) {
  const server = yield* HttpServer.HttpServer;
  const starting: HttpHandler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method === "GET" && request.url.split("?")[0] === "/api/version")
      return HttpServerResponse.jsonUnsafe(version, { headers: startupHeaders });
    return startupResponse("Startup recovery is in progress.");
  });
  const handler = yield* Ref.make(starting);
  const isStarted = yield* Ref.make(false);
  yield* server.serve(
    Effect.flatMap(Ref.get(isStarted), (started) =>
      started
        ? Effect.flatten(Ref.get(handler))
        : Effect.succeed(startupResponse("Startup is in progress.")),
    ),
    HttpMiddleware.logger,
  );
  yield* Effect.logInfo("HTTP listener ready; startup can continue", { version });
  return {
    install: (next: HttpHandler) =>
      Effect.acquireRelease(Ref.set(handler, next), () =>
        Ref.set(handler, starting).pipe(
          Effect.andThen(Effect.logInfo("HTTP routes removed; startup responses restored")),
        ),
      ),
    /**
     * Marks the instance as started: `GET /api/version` returns HTTP 200, which `usine up --detach`
     * and `usine restart` wait for, and installed routes answer. Run it after the admin token is
     * written, once setup mode serves and has logged its sign-in line, or before the runtime starts
     * worker checks and attempt recovery.
     */
    started: Ref.getAndSet(isStarted, true).pipe(
      Effect.flatMap((already) =>
        already ? Effect.void : Effect.logInfo("Instance started; GET /api/version answers"),
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
