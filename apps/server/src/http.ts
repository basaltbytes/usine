import { TaskView } from "@usine/orchestrator/operator";
import { shellOverview, pagedBoard, attentionOverview } from "./changes/reads.ts";
import { Changes } from "./changes/changes.ts";
import { conditionalReads } from "./conditional-reads.ts";
import type { StartupListener } from "./listener.ts";
import { RequestPermissions, InstanceScope, ProjectScope, permits } from "@usine/core/access";
import { DocumentationApi, operatorOpenApi } from "./openapi.ts";
import { setupRoutes } from "./setup/http.ts";
import type { Setup } from "./setup/control.ts";
import { securityMiddleware } from "./security.ts";
import { ProjectId } from "@usine/core/project";
import { LoopName } from "@usine/core/loop";
import { authenticatedRoutes, type AuthServices } from "./auth/http.ts";
import { HARNESSES, EFFORTS } from "@usine/core/agent/brain";
import { GitHubApp } from "@usine/github/github-app";
import { GitHubPolling } from "@usine/github/polling";
import { configurationRepositories, configurationLabels } from "./configuration/catalog.ts";
import { fromConfiguration, fromConfigurationRevision } from "./configuration/http.ts";
import { type UpgradeError, ServerUpgrades } from "./upgrade/control.ts";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import { RepositoryName } from "@usine/core/repository";
import { type ConfigurationEditor, BoardMove } from "@usine/orchestrator/operator";
import {
  OperatorApi,
  OperatorHttpError,
  OperatorHttpPolicy,
  operatorPermissions,
} from "@usine/orchestrator/operator/http";
import { Effect, Layer, Option, Schema, type Types } from "effect";
import {
  Headers,
  HttpPlatform,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { HttpApiBuilder, HttpApiError } from "effect/http-api";
import { FactoryBackend, type BackendError } from "./backend.ts";
import { type Port, SERVER_HOST } from "./cli.ts";

const operatorFailure = (error: BackendError) => {
  const message = (() => {
    switch (error._tag) {
      case "AccessDenied":
        return "You do not have permission for this operation.";
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
      case "WorkerPreflightRejectedError":
      case "BackendUnavailableError":
      case "RunRetryBlockedError":
      case "RunInterventionRejectedError":
      case "RosterAgentNotFoundError":
      case "LoopNotFoundError":
        return error.message;
      case "BoardProjectNotFoundError":
      case "BoardItemNotFoundError":
      case "BoardLaneNotFoundError":
      case "BoardLaneReadOnlyError":
      case "GitHubItemNotFoundError":
        return error.message;
      case "InstallationDiscoveryError":
      case "AppPermissionError":
        return error.message;
      case "GitHubApiError":
      case "InvalidGitHubResponseError":
        return error.message;
      case "GitHubRateLimitError":
        return error.message;
      case "ConfigurationStoreError":
        return `Configuration store error: could not ${error.operation}.`;
      case "EnginePersistenceError":
        return `Runtime store error: could not ${error.operation}.`;
      case "AttemptCancellationError":
        return `Attempt ${error.attemptId} could not be canceled.`;
    }
  })();
  return new OperatorHttpError({ error: error._tag, message });
};

const requireProjectRepository = (project: ProjectId, repository: RepositoryName) =>
  fromBackend((backend) => backend.configuration).pipe(
    Effect.flatMap((configuration) => {
      const member = configuration.projects.find(({ id }) => id === project);
      return member?.includes(repository) === true
        ? Effect.void
        : Effect.fail(
            new OperatorHttpError({
              error: "BoardProjectNotFoundError",
              message: `Repository ${repository} does not belong to project ${project}.`,
            }),
          );
    }),
  );

const policy = Layer.succeed(OperatorHttpPolicy)((handler, { endpoint }) =>
  Effect.gen(function* () {
    const requirement = Object.entries(operatorPermissions).find(
      ([name]) => name === endpoint.identifier,
    )?.[1];
    if (requirement !== "public") {
      const grants = yield* RequestPermissions;
      const params = yield* HttpRouter.params;
      const project = Schema.decodeUnknownOption(ProjectId)(params.project);
      const allowed =
        requirement !== undefined &&
        (permits(grants, "admin", new InstanceScope()) ||
          (Option.isSome(project)
            ? permits(grants, requirement, new ProjectScope({ project: project.value }))
            : grants.some(({ permission }) => permission === requirement)));
      if (!allowed) {
        yield* Effect.logWarning("Operator route permission refused", {
          route: endpoint.identifier,
          permission: requirement,
        });
        return yield* new OperatorHttpError({
          error: "AccessDenied",
          message: "You do not have permission for this operation.",
        });
      }
    }
    const request = yield* HttpServerRequest.HttpServerRequest;
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

const fromUpgrades = <A>(
  use: (upgrades: ServerUpgrades["Service"]) => Effect.Effect<A, UpgradeError>,
) =>
  Effect.gen(function* () {
    const upgrades = yield* Effect.serviceOption(ServerUpgrades);
    if (Option.isNone(upgrades))
      return yield* new OperatorHttpError({
        error: "UpgradeError",
        message: "Upgrades are unavailable until the factory is running.",
      });
    return yield* use(upgrades.value).pipe(
      Effect.mapError(
        (error) => new OperatorHttpError({ error: "UpgradeError", message: error.message }),
      ),
    );
  });

const handlers = HttpApiBuilder.group(
  OperatorApi,
  "operator",
  Effect.fn(function* (routes) {
    const changes = yield* Changes;
    return routes
      .handleRaw("changes", () =>
        Effect.gen(function* () {
          return yield* changes.stream(
            yield* FactoryBackend,
            yield* HttpServerRequest.HttpServerRequest,
            yield* RequestPermissions,
          );
        }),
      )
      .handle("upgradeStatus", () => fromUpgrades((upgrades) => upgrades.status))
      .handle("cancelUpgrade", () => fromUpgrades((upgrades) => upgrades.cancel).pipe(acknowledge))
      .handle("serverVersion", () =>
        fromUpgrades((upgrades) => upgrades.status.pipe(Effect.map((status) => status.running))),
      )
      .handle("serverReady", () => acknowledge(Effect.void))
      .handle("requestUpgrade", ({ payload }) =>
        fromUpgrades((upgrades) => upgrades.request(payload)).pipe(acknowledge),
      )
      .handle("workers", () =>
        fromBackend((backend) => backend.configuration).pipe(
          Effect.map(({ workers, removedWorkers }) => ({ workers, removedWorkers })),
        ),
      )
      .handle("overview", () =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const overview = yield* fromBackend((backend) => backend.overview);
          return request.headers["x-usine-view"] === "shell"
            ? shellOverview(overview)
            : request.headers["x-usine-view"] === "attention"
              ? attentionOverview(overview)
              : overview;
        }),
      )
      .handle("project", ({ params }) =>
        fromBackend((backend) => backend.overview).pipe(
          Effect.flatMap((overview) => {
            const project = overview.projects.find(({ id }) => id === params.project);
            return project === undefined
              ? Effect.fail(
                  new OperatorHttpError({
                    error: "BoardProjectNotFoundError",
                    message: `Project ${params.project} was not found.`,
                  }),
                )
              : Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
                  Effect.succeed(
                    request.headers["x-usine-view"] === "board" ? pagedBoard(project) : project,
                  ),
                );
          }),
        ),
      )
      .handle("boardLaneItems", ({ params, query }) =>
        fromBackend((backend) => backend.overview).pipe(
          Effect.flatMap((overview) => {
            const lane = overview.projects
              .find(({ id }) => id === params.project)
              ?.board.lanes.find(({ id }) => id === params.lane);
            if (lane === undefined)
              return Effect.fail(
                new OperatorHttpError({
                  error: "BoardLaneNotFoundError",
                  message: "The project lane was not found.",
                }),
              );
            const offset = query.offset ?? 0;
            const items = lane.items.slice(offset, offset + 50);
            return Effect.succeed({
              items,
              total: lane.items.length,
              nextOffset: offset + items.length < lane.items.length ? offset + items.length : null,
            });
          }),
        ),
      )
      .handle("projectTask", ({ params, query }) =>
        requireProjectRepository(params.project, query.repository).pipe(
          Effect.andThen(fromBackend((backend) => backend.task(query.repository, params.item))),
        ),
      )
      .handle("moveProjectItem", ({ params, payload }) =>
        requireProjectRepository(params.project, payload.repository).pipe(
          Effect.andThen(
            fromBackend((backend) =>
              backend.moveBoardItem(
                new BoardMove({
                  repository: payload.repository,
                  item: params.item,
                  toLane: payload.toLane,
                }),
              ),
            ),
          ),
          acknowledge,
        ),
      )
      .handle("pauseProjectLoop", ({ params }) =>
        fromBackend((backend) =>
          backend.pause(LoopName.make(`${params.project}/${params.loop}`)),
        ).pipe(acknowledge),
      )
      .handle("unpauseProjectLoop", ({ params }) =>
        fromBackend((backend) =>
          backend.unpause(LoopName.make(`${params.project}/${params.loop}`)),
        ).pipe(acknowledge),
      )
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
      .handle("dismissNeed", ({ payload }) =>
        fromBackend((backend) => backend.dismissNeed(payload)).pipe(acknowledge),
      )
      .handle("undoDismissNeed", ({ payload }) =>
        fromBackend((backend) => backend.undoDismissNeed(payload)).pipe(acknowledge),
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
      .handle("runWorkerPreflight", ({ params }) =>
        fromBackend((backend) => backend.runWorkerPreflight(params.worker)),
      )
      .handle("discardLeftovers", ({ params }) =>
        fromBackend((backend) => backend.discardLeftovers(params.worker)).pipe(acknowledge),
      )
      .handle(
        "moveBoardItem",
        Effect.fn("Http.boardMove")(function* ({ params, payload }) {
          const repository = yield* projectRepository(params);
          yield* Effect.annotateCurrentSpan({
            repository,
            item: params.item,
            lane: payload.toLane,
          });
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
      .handle("taskRuns", ({ params, query }) =>
        Effect.gen(function* () {
          const repository = yield* projectRepository(params);
          const task = yield* fromBackend((backend) => backend.task(repository, params.item));
          const offset = query.offset ?? 0;
          const runs = task.runs.slice(offset, offset + 25);
          return {
            runs,
            total: task.runs.length,
            nextOffset: offset + runs.length < task.runs.length ? offset + runs.length : null,
          };
        }),
      )
      .handle(
        "task",
        Effect.fn("Http.task")(function* ({ params }) {
          const repository = yield* projectRepository(params);
          yield* Effect.annotateCurrentSpan({ repository, item: params.item });
          const task = yield* fromBackend((backend) => backend.task(repository, params.item));
          const request = yield* HttpServerRequest.HttpServerRequest;
          return request.headers["x-usine-view"] === "task"
            ? new TaskView({
                ...task,
                runsTotal: task.runs.length,
                runs: task.runs.slice(0, 25),
                commentRuns: task.runs.map(({ id, repository, itemKey, loop }) => ({
                  id,
                  repository,
                  itemKey,
                  loop,
                })),
              })
            : task;
        }),
      )
      .handle("checkLoop", ({ payload }) =>
        fromConfiguration((editor) => editor.checkLoop(payload)),
      )
      .handle("previewLoop", ({ payload }) =>
        fromConfiguration((editor) => editor.previewLoop(payload)),
      )
      .handle("configurationHead", () =>
        fromConfiguration((editor) => editor.head).pipe(Effect.map((number) => ({ number }))),
      )
      .handle("configurationCapabilities", () =>
        Effect.succeed({ harnesses: HARNESSES, efforts: EFFORTS }),
      )
      .handle("configurationRepositories", () => configurationRepositories())
      .handle("configurationLabels", ({ params }) =>
        Effect.gen(function* () {
          const grants = yield* RequestPermissions;
          if (permits(grants, "admin", new InstanceScope()))
            return yield* configurationLabels(params.repository);
          const view = yield* fromBackend((backend) => backend.configuration);
          if (
            !view.repositories.some(
              ({ name }) => name.toLowerCase() === params.repository.toLowerCase(),
            )
          )
            return yield* new OperatorHttpError({
              error: "AccessDenied",
              message: "You do not have access to this repository.",
            });
          return yield* configurationLabels(params.repository);
        }),
      )
      .handle("configurationRevisions", ({ query }) =>
        fromConfiguration((editor) => editor.list(query)),
      )
      .handle("configurationRevision", ({ params }) =>
        fromConfigurationRevision((editor) => editor.revision(params.number)),
      )
      .handle("configurationEntity", ({ params }) =>
        fromConfiguration((editor) => editor.entity(params)),
      )
      .handle("replaceConfigurationEntity", ({ params, payload }) =>
        fromConfigurationRevision((editor) => editor.replace(params, payload)),
      )
      .handle("deleteConfigurationEntity", ({ params, payload }) =>
        fromConfigurationRevision((editor) => editor.remove(params, payload)),
      )
      .handle("revertConfigurationRevision", ({ params, payload }) =>
        fromConfigurationRevision((editor) => editor.revert(params.number, payload)),
      )
      .handle("configuration", () => fromBackend((backend) => backend.configuration))
      .handle("desk", () => fromBackend((backend) => backend.desk))
      .handle("statistics", ({ query }) =>
        fromBackend((backend) => backend.statistics(query.window)),
      )
      .handle("runStatistics", ({ query }) =>
        fromBackend((backend) => backend.runStatistics(query.window)),
      );
  }),
);

/**
 * Returns the operator API routes.
 */
export const apiRoutes = () =>
  Layer.mergeAll(
    HttpApiBuilder.layer(OperatorApi),
    conditionalReads,
    HttpRouter.add(
      DocumentationApi.endpoints.openapi.method,
      DocumentationApi.endpoints.openapi.path,
      HttpServerResponse.jsonUnsafe(operatorOpenApi()),
    ),
  ).pipe(
    Layer.provide(handlers),
    Layer.provide(Changes.layer),
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
          pathname === "/webhooks" ||
          pathname.startsWith("/webhooks/") ||
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

/**
 * Serves the authenticated operator API and the UI on `SERVER_HOST` at `port`.
 */
export const serverLayer = (
  backend: Layer.Layer<FactoryBackend>,
  webRoot: string,
  port: Port,
  auth: AuthServices,
  services:
    | Layer.Layer<ServerUpgrades | ConfigurationEditor | GitHubApp | GitHubPolling>
    | Layer.Layer<never> = Layer.empty,
  webhooks: Layer.Layer<never, never, HttpRouter.HttpRouter> = Layer.empty,
  setup?: Setup["Service"],
  listener?: StartupListener,
) => {
  const authenticated = authenticatedRoutes(auth);
  const setupHttp =
    setup === undefined ? undefined : setupRoutes(setup, auth.authentication.origin);
  const routes = Layer.mergeAll(
    setupHttp?.protected.pipe(Layer.provide(authenticated.guard.layer)) ?? Layer.empty,
    setupHttp?.callback ?? Layer.empty,
    apiRoutes().pipe(Layer.provide(authenticated.guard.layer)),
    staticRoutes(webRoot),
    authenticated.routes,
    webhooks,
    securityMiddleware(auth.authentication),
  ).pipe(HttpRouter.provideRequest(Layer.merge(backend, services)));
  if (listener !== undefined)
    return Layer.effectDiscard(
      Effect.gen(function* () {
        const platform = yield* HttpPlatform.HttpPlatform;
        const handler = yield* HttpRouter.toHttpEffect(routes);
        yield* listener.install(
          handler.pipe(Effect.provideService(HttpPlatform.HttpPlatform, platform)),
        );
      }),
    ).pipe(Layer.provide(NodeHttpServer.layerHttpServices));
  return HttpRouter.serve(routes).pipe(
    Layer.provide(NodeHttpServer.layer(createServer, { host: SERVER_HOST, port })),
  );
};
