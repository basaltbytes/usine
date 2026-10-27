import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import { RepositoryName } from "@usine/core/repository";
import { BoardMove } from "@usine/orchestrator/operator";
import {
  OperatorApi,
  OperatorHttpError,
  OperatorHttpPolicy,
  reloadRefusal,
} from "@usine/orchestrator/operator/http";
import { Effect, Layer, Schema, type Types } from "effect";
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder, HttpApiError } from "effect/http-api";
import { FactoryBackend, type BackendError } from "./backend.ts";
import { SERVER_HOST } from "./cli.ts";

const operatorFailure = (error: BackendError) => {
  const message = (() => {
    switch (error._tag) {
      case "RunNotFoundError":
        return `Run ${error.runId} was not found.`;
      case "RunOperationRejectedError":
        if (error.operation === "resolveFailure")
          return "This failure is no longer the current one. Refresh the run, then mark it resolved.";
        if (error.operation === "runAgain")
          return `Run ${error.runId} is ${error.state.toLowerCase()}. Only a succeeded or canceled run can run again.`;
        return `Cannot ${error.operation} run ${error.runId} while it is ${error.state.toLowerCase()}.`;
      case "CycleBudgetResetRejectedError":
        return `Cycle budget ask ${error.askId} is no longer open.`;
      case "TranscriptAttemptNotFoundError":
        return `Attempt ${error.attemptId} does not belong to run ${error.runId}.`;
      case "LeftoversDiscardRejectedError":
        // No running Attempt: the Worker is back in usine.yaml, or its last Attempt is ending.
        if (error.running === 0)
          return `Could not discard the leftovers on worker "${error.worker}": it is in usine.yaml, or an attempt on it is ending.`;
        return `${error.running} ${error.running === 1 ? "attempt is" : "attempts are"} still running on worker "${error.worker}". Discard its leftovers after they end.`;
      case "BackendUnavailableError":
      case "RunRetryBlockedError":
      case "RunInterventionRejectedError":
      case "RosterAgentNotFoundError":
      case "LoopNotFoundError":
        return error.message;
      case "BoardProjectNotFoundError":
        return `Project "${error.repository}" was not found.`;
      case "BoardItemNotFoundError":
        return `Item ${error.repository}#${error.item} was not found on the board.`;
      case "BoardLaneNotFoundError":
        return `Lane "${error.lane}" was not found on the board.`;
      case "GitHubItemNotFoundError":
        return error.message;
      case "BoardLaneReadOnlyError":
        return `Lane "${error.lane}" is read-only. To move items, configure label-backed lanes in usine.yaml.`;
      case "InstallationDiscoveryError":
      case "AppPermissionError":
        return error.message;
      case "GitHubApiError":
      case "InvalidGitHubResponseError":
        return error.message;
      case "GitHubRateLimitError":
        return error.message;
      case "EnginePersistenceError":
        return `Runtime store error: could not ${error.operation}.`;
      case "AttemptCancellationError":
        return `Attempt ${error.attemptId} could not be canceled.`;
      case "FactoryConfigError":
        return error.stage === "read"
          ? `Could not read ${error.file}: ${error.message.replace(/\.$/u, "")}. The running configuration is unchanged.`
          : `${error.file} is invalid (${error.stage}): ${error.message.replace(/\.$/u, "")}. The running configuration is unchanged.`;
      case "RestartRequiredError":
      case "ReloadPreflightError":
        return error.message;
    }
  })();
  return new OperatorHttpError({ error: error._tag, message });
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Whether the request has a non-loopback `Origin`, which marks a cross-site request. Requests
 * without `Origin` (curl, same-origin GETs) are allowed.
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

const policy = Layer.succeed(OperatorHttpPolicy)((handler, { endpoint }) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (crossSiteOrigin(request)) {
      yield* Effect.logWarning("Cross-site request to the operator API was refused", {
        origin: request.headers.origin,
        url: request.url,
      });
      return yield* new OperatorHttpError({
        error: "CrossSiteRequestError",
        message: "Cross-site requests are not allowed.",
      });
    }
    // JSON is accepted regardless of Content-Type, including simple browser POSTs;
    // `crossSiteOrigin` guards against CSRF.
    const decoded =
      endpoint.payload.size === 0
        ? handler
        : handler.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              request.modify({
                headers: Headers.set(request.headers, "content-type", "application/json"),
              }),
            ),
          );
    return yield* decoded.pipe(
      Effect.catch((error): Effect.Effect<never, OperatorHttpError | Types.unhandled> => {
        if (!HttpApiError.HttpApiSchemaError.is(error)) return Effect.fail(error);
        const responseEncoding = error.kind === "Body" || error.kind === "ResponseHeaders";
        return Effect.fail(
          new OperatorHttpError({
            error: responseEncoding
              ? "HttpBodyError"
              : error.kind === "Payload"
                ? "InvalidRequestError"
                : "SchemaError",
            message: responseEncoding
              ? "The server could not encode its response."
              : `Invalid request: ${error.cause.message}`,
          }),
        );
      }),
    );
  }),
);

const acknowledge = <E, R>(effect: Effect.Effect<void, E, R>) =>
  Effect.as(effect, { ok: true } as const);

const fromBackend = <A>(
  use: (backend: FactoryBackend["Service"]) => Effect.Effect<A, BackendError>,
) => Effect.flatMap(FactoryBackend, use).pipe(Effect.mapError(operatorFailure));

const projectRepository = (params: { readonly owner: string; readonly repository: string }) =>
  Schema.decodeUnknownEffect(RepositoryName)(`${params.owner}/${params.repository}`).pipe(
    Effect.mapError(
      (error) =>
        new OperatorHttpError({
          error: "SchemaError",
          message: `Invalid request: ${error.message}`,
        }),
    ),
  );

const handlers = HttpApiBuilder.group(OperatorApi, "operator", (routes) =>
  routes
    .handle("overview", () => fromBackend((backend) => backend.overview))
    .handle("agents", () => fromBackend((backend) => backend.agents))
    .handle("editAndRetry", ({ params, payload }) =>
      fromBackend((backend) => backend.editAndRetry(params.runId, payload)).pipe(acknowledge),
    )
    .handle("runAgain", ({ params, payload }) =>
      fromBackend((backend) => backend.runAgain(params.runId, payload)),
    )
    .handle("intervene", ({ params, payload }) =>
      fromBackend((backend) => backend.intervene(params.runId, payload)).pipe(acknowledge),
    )
    .handle("resetCycleBudget", ({ payload }) =>
      fromBackend((backend) => backend.resetCycleBudget(payload.askId)).pipe(acknowledge),
    )
    .handle("detail", ({ params, query }) =>
      fromBackend((backend) => backend.detail(params.runId, query)),
    )
    .handle("githubChanges", ({ params }) =>
      fromBackend((backend) => backend.githubChanges(params.runId)),
    )
    .handle("approve", ({ params }) =>
      fromBackend((backend) => backend.approve(params.runId)).pipe(acknowledge),
    )
    .handle("resolveFailure", ({ params, payload }) =>
      fromBackend((backend) => backend.resolveFailure(params.runId, payload.attemptId)).pipe(
        acknowledge,
      ),
    )
    .handle("retry", ({ params }) =>
      fromBackend((backend) => backend.retry(params.runId)).pipe(acknowledge),
    )
    .handle("cancel", ({ params }) =>
      fromBackend((backend) => backend.cancel(params.runId)).pipe(acknowledge),
    )
    .handle("discardLeftovers", ({ params }) =>
      fromBackend((backend) => backend.discardLeftovers(params.worker)).pipe(acknowledge),
    )
    .handle(
      "moveBoardItem",
      Effect.fn("Http.boardMove")(function* ({ params, payload }) {
        const repository = yield* projectRepository(params);
        yield* Effect.annotateCurrentSpan({ repository, item: params.item, lane: payload.toLane });
        return yield* fromBackend((backend) =>
          backend.moveBoardItem(
            new BoardMove({ repository, item: params.item, toLane: payload.toLane }),
          ),
        ).pipe(acknowledge);
      }),
    )
    .handle("pause", ({ params }) =>
      fromBackend((backend) => backend.pause(params.loop)).pipe(acknowledge),
    )
    .handle("unpause", ({ params }) =>
      fromBackend((backend) => backend.unpause(params.loop)).pipe(acknowledge),
    )
    .handle("reload", () =>
      Effect.flatMap(FactoryBackend, (backend) => backend.reload).pipe(
        Effect.mapError((error) => {
          const failure = operatorFailure(error);
          switch (error._tag) {
            case "FactoryConfigError":
            case "RestartRequiredError":
            case "ReloadPreflightError":
              return reloadRefusal(error, failure.message);
            default:
              return failure;
          }
        }),
      ),
    )
    .handle(
      "task",
      Effect.fn("Http.task")(function* ({ params }) {
        const repository = yield* projectRepository(params);
        yield* Effect.annotateCurrentSpan({ repository, item: params.item });
        return yield* fromBackend((backend) => backend.task(repository, params.item));
      }),
    )
    .handle("configuration", () => fromBackend((backend) => backend.configuration))
    .handle("desk", () => fromBackend((backend) => backend.desk))
    .handle("statistics", ({ query }) => fromBackend((backend) => backend.statistics(query.window)))
    .handle("runStatistics", ({ query }) =>
      fromBackend((backend) => backend.runStatistics(query.window)),
    ),
);

export const apiRoutes = HttpApiBuilder.layer(OperatorApi).pipe(
  Layer.provide(handlers),
  Layer.provide(policy),
  Layer.provide(NodeHttpServer.layerHttpServices),
);

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
    Layer.provide(NodeHttpServer.layer(createServer, { host: SERVER_HOST, port })),
  );
};
