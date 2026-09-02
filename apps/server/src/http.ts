import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import { Attempt, Item, Loop, Repository, Run } from "@usine/core";
import {
  BoardLaneId,
  BoardMove,
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
const RepositoryPart = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_.-]+$/u, { message: "Expected a repository path segment" }),
);
const PathBoardItem = Schema.Struct({
  owner: RepositoryPart,
  repository: RepositoryPart,
  item: Schema.FiniteFromString.pipe(Schema.decodeTo(Item.Number)),
});
const BoardMoveBody = Schema.Struct({ toLane: BoardLaneId });
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

class InvalidRequestError extends Schema.TaggedError<InvalidRequestError>(
  "@usine/server/InvalidRequestError",
)("InvalidRequestError", { message: Schema.String }) {}

type RouteError = BackendError | HttpBody.HttpBodyError | InvalidRequestError | Schema.SchemaError;

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
      case "BoardProjectNotFoundError":
        return { status: 404, message: `Project ${error.repository} was not found.` } as const;
      case "BoardItemNotFoundError":
        return {
          status: 404,
          message: `Item ${error.repository}#${error.item} was not found on the Board.`,
        } as const;
      case "BoardLaneNotFoundError":
        return { status: 404, message: `Board Lane ${error.lane} was not found.` } as const;
      case "BoardLaneReadOnlyError":
        return {
          status: 409,
          message: `Board Lane ${error.lane} is derived from Item state and cannot accept label moves.`,
        } as const;
      case "InstallationDiscoveryError":
      case "AppPermissionError":
        return { status: 503, message: error.message } as const;
      case "GitHubApiError":
      case "InvalidGitHubResponseError":
        return { status: 502, message: error.message } as const;
      case "GitHubRateLimitError":
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
      case "InvalidRequestError":
        return { status: 400, message: error.message } as const;
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

const boardMove = Effect.fn("Http.boardMove")(function* () {
  const { owner, repository: name, item } = yield* HttpRouter.schemaPathParams(PathBoardItem);
  const repository = yield* Schema.decodeUnknownEffect(Repository.Name)(`${owner}/${name}`);
  const { toLane } = yield* HttpServerRequest.schemaBodyJson(BoardMoveBody, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError(
      (error) => new InvalidRequestError({ message: `Invalid request: ${error.message}` }),
    ),
  );
  return new BoardMove({ repository, item, toLane });
});

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
    "/api/projects/:owner/:repository/items/:item/lane",
    handled(
      Effect.gen(function* () {
        const backend = yield* FactoryBackend;
        yield* backend.moveBoardItem(yield* boardMove());
        return yield* ok({ ok: true });
      }),
    ),
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
  const applicationShell = HttpServerResponse.file(resolve(webRoot, "index.html"));
  return HttpRouter.addAll([
    HttpRouter.route("GET", "/", applicationShell),
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
    HttpRouter.route("GET", "*", (request) =>
      Effect.gen(function* () {
        const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
        const reservedNamespace =
          pathname === "/api" ||
          pathname.startsWith("/api/") ||
          pathname === "/assets" ||
          pathname.startsWith("/assets/");
        const hasFileExtension = extname(pathname) !== "";
        if (reservedNamespace || hasFileExtension) {
          yield* Effect.logDebug("Request was not eligible for the application shell fallback", {
            pathname,
            reason: reservedNamespace ? "reserved-namespace" : "file-extension",
          });
          return HttpServerResponse.text("Not found", { status: 404 });
        }
        yield* Effect.logDebug("Serving the application shell for a client route", { pathname });
        return yield* applicationShell;
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
