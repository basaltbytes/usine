import { Effect, Ref, type Scope, type PlatformError } from "effect";
import {
  HttpMiddleware,
  HttpServer,
  type HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

type HttpHandler = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  HttpServerError.HttpServerError | PlatformError.PlatformError,
  HttpServerRequest.HttpServerRequest | Scope.Scope
>;

/** Serves the version during startup, then installs the runtime routes on the same listener. */
export const startupListener = Effect.fnUntraced(function* (version: string) {
  const server = yield* HttpServer.HttpServer;
  const handler = yield* Ref.make<HttpHandler>(
    Effect.gen(function* () {
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
    }),
  );
  yield* server.serve(Effect.flatten(Ref.get(handler)), HttpMiddleware.logger);
  yield* Effect.logInfo("HTTP listener ready; startup recovery can continue", { version });
  return { install: (next: HttpHandler) => Ref.set(handler, next) };
});

export type StartupListener = Effect.Success<ReturnType<typeof startupListener>>;
