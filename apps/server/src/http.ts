import { createServer } from "node:http";
import { resolve, sep } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import { Loop, Run } from "@usine/core";
import { FactoryOverview, RunDetailView } from "@usine/orchestrator";
import { Effect, Layer, Schema } from "effect";
import { HttpBody, HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { FactoryBackend, type BackendError } from "./backend.ts";

const PathRun = Schema.Struct({ runId: Run.RunId });
const PathLoop = Schema.Struct({ loop: Loop.LoopName });
const ApiOk = Schema.Struct({ ok: Schema.Literal(true) });
const ApiError = Schema.Struct({ error: Schema.String, message: Schema.String });
const ok = HttpServerResponse.schemaJson(ApiOk);

type RouteError = BackendError | HttpBody.HttpBodyError | Schema.SchemaError;

const errorResponse = (error: RouteError) => {
  const response = (() => {
    switch (error._tag) {
      case "RunNotFoundError":
        return { status: 404, message: `Run ${error.runId} was not found.` } as const;
      case "RunOperationRejectedError":
        return {
          status: 409,
          message: `Cannot ${error.operation} Run ${error.runId} while it is ${error.state}.`,
        } as const;
      case "BackendUnavailableError":
        return { status: 503, message: error.message } as const;
      case "EnginePersistenceError":
        return {
          status: 500,
          message: `Runtime persistence failed while trying to ${error.operation}.`,
        } as const;
      case "AttemptCancellationError":
        return {
          status: 500,
          message: `Attempt ${error.attemptId} could not be canceled.`,
        } as const;
      case "SchemaError":
        return { status: 400, message: `Invalid request: ${error.message}` } as const;
      case "HttpBodyError":
        return { status: 500, message: "The server could not encode its response." } as const;
    }
  })();
  return HttpServerResponse.schemaJson(ApiError)(
    { error: error._tag, message: response.message },
    { status: response.status },
  ).pipe(Effect.orDie);
};

const handled = <A, E extends RouteError, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.catch(errorResponse));

const runAction = (
  action: (
    backend: FactoryBackend["Service"],
    runId: Run.RunId,
  ) => ReturnType<FactoryBackend["Service"]["approve"]>,
) =>
  handled(
    Effect.gen(function* () {
      const backend = yield* FactoryBackend;
      const { runId } = yield* HttpRouter.schemaPathParams(PathRun);
      yield* action(backend, runId);
      return yield* ok({ ok: true });
    }),
  );

const loopAction = (
  action: (
    backend: FactoryBackend["Service"],
    loop: Loop.LoopName,
  ) => ReturnType<FactoryBackend["Service"]["pause"]>,
) =>
  handled(
    Effect.gen(function* () {
      const backend = yield* FactoryBackend;
      const { loop } = yield* HttpRouter.schemaPathParams(PathLoop);
      yield* action(backend, loop);
      return yield* ok({ ok: true });
    }),
  );

export const apiRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/overview",
    handled(
      Effect.gen(function* () {
        const backend = yield* FactoryBackend;
        return yield* HttpServerResponse.schemaJson(FactoryOverview)(yield* backend.overview);
      }),
    ),
  ),
  HttpRouter.route(
    "GET",
    "/api/runs/:runId",
    handled(
      Effect.gen(function* () {
        const backend = yield* FactoryBackend;
        const { runId } = yield* HttpRouter.schemaPathParams(PathRun);
        return yield* HttpServerResponse.schemaJson(RunDetailView)(yield* backend.detail(runId));
      }),
    ),
  ),
  HttpRouter.route(
    "POST",
    "/api/runs/:runId/approve",
    runAction((backend, id) => backend.approve(id)),
  ),
  HttpRouter.route(
    "POST",
    "/api/runs/:runId/retry",
    runAction((backend, id) => backend.retry(id)),
  ),
  HttpRouter.route(
    "POST",
    "/api/runs/:runId/cancel",
    runAction((backend, id) => backend.cancel(id)),
  ),
  HttpRouter.route(
    "POST",
    "/api/loops/:loop/pause",
    loopAction((backend, loop) => backend.pause(loop)),
  ),
  HttpRouter.route(
    "POST",
    "/api/loops/:loop/unpause",
    loopAction((backend, loop) => backend.unpause(loop)),
  ),
]);

const staticRoutes = (webRoot: string) => {
  const assetsRoot = resolve(webRoot, "assets");
  return HttpRouter.addAll([
    HttpRouter.route("GET", "/", HttpServerResponse.file(resolve(webRoot, "index.html"))),
    HttpRouter.route("GET", "/assets/*", (request) =>
      Effect.gen(function* () {
        const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
        const asset = resolve(webRoot, pathname.slice(1));
        if (!asset.startsWith(`${assetsRoot}${sep}`)) {
          return HttpServerResponse.text("Not found", { status: 404 });
        }
        return yield* HttpServerResponse.file(asset).pipe(
          Effect.catch(() => Effect.succeed(HttpServerResponse.text("Not found", { status: 404 }))),
        );
      }),
    ),
  ]);
};

export const serverLayer = (
  backend: Layer.Layer<FactoryBackend>,
  webRoot: string,
  port: number,
) => {
  const routes = Layer.mergeAll(apiRoutes, staticRoutes(webRoot)).pipe(
    HttpRouter.provideRequest(backend),
  );
  return HttpRouter.serve(routes).pipe(
    Layer.provide(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port })),
  );
};
