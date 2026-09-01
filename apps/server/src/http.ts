import { createServer } from "node:http";
import { resolve, sep } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import { Attempt, Loop, Run } from "@usine/core";
import {
  ColdTranscriptRequest,
  EarlierTranscriptRequest,
  FactoryOverview,
  RunDetailView,
  TailTranscriptRequest,
  TranscriptCursor,
  type TranscriptRequest,
} from "@usine/orchestrator";
import { Effect, Layer, Match, Schema } from "effect";
import { HttpBody, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { FactoryBackend, type BackendError } from "./backend.ts";

const PathRun = Schema.Struct({ runId: Run.RunId });
const PathLoop = Schema.Struct({ loop: Loop.LoopName });
const TranscriptCursorFromString = Schema.FiniteFromString.pipe(Schema.decodeTo(TranscriptCursor));
const RunDetailSearch = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("ColdTranscriptRequest") }),
  Schema.Struct({
    _tag: Schema.Literal("TailTranscriptRequest"),
    after: TranscriptCursorFromString,
  }),
  Schema.Struct({
    _tag: Schema.Literal("EarlierTranscriptRequest"),
    attemptId: Attempt.AttemptId,
    before: TranscriptCursorFromString,
  }),
]);
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
      case "TranscriptAttemptNotFoundError":
        return {
          status: 404,
          message: `Attempt ${error.attemptId} does not belong to Run ${error.runId}.`,
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

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Cross-site request forgery guard. Browsers attach `Origin` to every
 * cross-origin request — including the "simple" POSTs this API accepts — so a
 * present, non-loopback origin can only be another site driving the
 * operator's browser, and its side effect must be refused before the handler
 * runs. Requests without the header (curl, same-origin GETs) pass through.
 */
const crossSiteOrigin = (request: HttpServerRequest.HttpServerRequest): boolean => {
  const origin = request.headers.origin;
  if (origin === undefined) return false;
  try {
    return !LOOPBACK_HOSTS.has(new URL(origin).hostname);
  } catch {
    return true;
  }
};

const handled = <A, E extends RouteError, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (crossSiteOrigin(request)) {
      yield* Effect.logWarning("Cross-site request to the operator API was refused", {
        origin: request.headers.origin,
        url: request.url,
      });
      return yield* HttpServerResponse.schemaJson(ApiError)(
        { error: "CrossSiteRequestError", message: "Cross-site requests are refused." },
        { status: 403 },
      ).pipe(Effect.orDie);
    }
    return yield* effect.pipe(Effect.catch(errorResponse));
  });

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

const transcriptRequest = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<TranscriptRequest, Schema.SchemaError> => {
  const params = new URL(request.url, "http://localhost").searchParams;
  const after = params.get("after");
  const before = params.get("before");
  const attemptId = params.get("attempt");
  const input: unknown =
    after === null && before === null && attemptId === null
      ? { _tag: "ColdTranscriptRequest" }
      : after !== null && before === null && attemptId === null
        ? { _tag: "TailTranscriptRequest", after }
        : after === null && before !== null && attemptId !== null
          ? { _tag: "EarlierTranscriptRequest", attemptId, before }
          : { _tag: "InvalidTranscriptRequest" };
  return Schema.decodeUnknownEffect(RunDetailSearch)(input, { onExcessProperty: "error" }).pipe(
    Effect.map((search) =>
      Match.valueTags(search, {
        ColdTranscriptRequest: () => new ColdTranscriptRequest(),
        TailTranscriptRequest: ({ after }) => new TailTranscriptRequest({ after }),
        EarlierTranscriptRequest: ({ attemptId, before }) =>
          new EarlierTranscriptRequest({ attemptId, before }),
      }),
    ),
  );
};

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
  HttpRouter.route("GET", "/api/runs/:runId", (request) =>
    handled(
      Effect.gen(function* () {
        const backend = yield* FactoryBackend;
        const { runId } = yield* HttpRouter.schemaPathParams(PathRun);
        return yield* HttpServerResponse.schemaJson(RunDetailView)(
          yield* backend.detail(runId, yield* transcriptRequest(request)),
        );
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

export const staticRoutes = (webRoot: string) => {
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
          Effect.catch((error) =>
            Effect.logDebug("Static asset could not be served", {
              asset,
              message: String(error),
            }).pipe(Effect.as(HttpServerResponse.text("Not found", { status: 404 }))),
          ),
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
