import { GitHubFiles } from "@usine/github/files";
import { CommitRangeFilesQuery, PullRequestFilesQuery } from "@usine/github/file-changes";
import { providerRoutes } from "./providers/http.ts";
import type { ProviderLogins } from "./providers/control.ts";
import { catalog, harnessPresentations } from "@usine/agents/harness";
import { configurationSummary, ItemEntryCursor, pageOf } from "@usine/orchestrator/operator";
import type { ItemNumber } from "@usine/core/item";
import {
  attentionOverview,
  pagedBoard,
  projectSummary,
  shellOverview,
  summaryOverview,
  taskPage,
  taskSummary,
  boundedDesk,
  fileChangesPage,
  revisionPage,
} from "./changes/reads.ts";
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
import {
  authenticatedRoutes,
  RequestCredentialKind,
  RequestOperations,
  type AuthServices,
} from "./auth/http.ts";
import { ceilingAdmits } from "./auth/model.ts";
import { mcpRoutes } from "./mcp/http.ts";
import { EFFORTS } from "@usine/core/agent/brain";
import { GitHubApp } from "@usine/github/github-app";
import { GitHubPolling } from "@usine/github/polling";
import { configurationRepositories, configurationLabels } from "./configuration/catalog.ts";
import { fromConfiguration, fromConfigurationRevision } from "./configuration/http.ts";
import { type UpgradeError, ServerUpgrades } from "./upgrade/control.ts";
import { NodeHttpServer } from "@effect/platform-node";
import { RepositoryName } from "@usine/core/repository";
import { type ConfigurationEditor, BoardMove } from "@usine/orchestrator/operator";
import {
  ConfigurationEntityRequest,
  ConfigurationRevisionQuery,
  OperatorApi,
  OperatorHttpError,
  OperatorHttpPolicy,
  conversationPermissions,
  operatorPermissions,
} from "@usine/orchestrator/operator/http";
import type { Conversations } from "@usine/orchestrator/conversation";
import type { Permissions } from "@usine/orchestrator/conversation/permissions";
import { conversationHandlers } from "./supervisor/conversations-http.ts";
import { ByteSize, Effect, Layer, Option, Path, Schema, type Types } from "effect";
import {
  Headers,
  HttpPlatform,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { HttpApiBuilder, HttpApiError } from "effect/http-api";
import { FactoryBackend, type BackendError } from "./backend.ts";

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
        if (error.operation === "applyCiLabels")
          return "This failure is no longer the current CI failure. Refresh the run before you apply the CI labels.";
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
      case "CiNotPassedError":
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
  return OperatorHttpError.make({ error: error._tag, message });
};

const requireProjectRepository = (project: ProjectId, repository: RepositoryName) =>
  fromBackend((backend) => backend.configuration).pipe(
    Effect.flatMap((configuration) => {
      const member = configuration.projects.find(({ id }) => id === project);
      return member?.includes(repository) === true
        ? Effect.void
        : Effect.fail(
            OperatorHttpError.make({
              error: "BoardProjectNotFoundError",
              message: `Repository ${repository} does not belong to project ${project}.`,
            }),
          );
    }),
  );

const permissionsOf = (group: string) =>
  group === OperatorApi.groups.conversation.identifier
    ? conversationPermissions
    : operatorPermissions;

const policy = Layer.succeed(OperatorHttpPolicy)((handler, { endpoint, group }) =>
  Effect.gen(function* () {
    const requirement = Object.entries(permissionsOf(group.identifier)).find(
      ([name]) => name === endpoint.identifier,
    )?.[1];
    if (requirement !== "public") {
      const grants = yield* RequestPermissions;
      const params = yield* HttpRouter.params;
      const project = Schema.decodeUnknownOption(ProjectId)(params.project);
      const allowed =
        requirement !== undefined &&
        (permits(grants, "admin", InstanceScope.make()) ||
          (Option.isSome(project)
            ? permits(grants, requirement, ProjectScope.make({ project: project.value }))
            : grants.some(({ permission }) => permission === requirement)));
      if (!allowed) {
        yield* Effect.logWarning("Operator route permission refused", {
          route: endpoint.identifier,
          permission: requirement,
        });
        return yield* OperatorHttpError.make({
          error: "AccessDenied",
          message: "You do not have permission for this operation.",
        });
      }
    }
    const operation = `${group.identifier}.${endpoint.identifier}`;
    // A supervisor turn is read-only, and must not start conversations or queue more turns.
    const credential = yield* RequestCredentialKind;
    if (
      Option.contains(credential, "turn") &&
      (group.identifier === OperatorApi.groups.conversation.identifier ||
        (requirement !== "read" && requirement !== "public"))
    ) {
      yield* Effect.logWarning("Operation refused for a supervisor turn", { operation });
      return yield* OperatorHttpError.make({
        error: "AccessDenied",
        message: `A supervisor turn can only read; it cannot call ${operation}.`,
      });
    }
    const ceiling = yield* RequestOperations;
    if (requirement !== "public" && !ceilingAdmits(ceiling, operation)) {
      yield* Effect.logWarning("Operator route refused by the token's operation ceiling", {
        route: endpoint.identifier,
      });
      return yield* OperatorHttpError.make({
        error: "AccessDenied",
        message: `This token cannot call ${operation}.`,
      });
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
          OperatorHttpError.make({
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

/** The cards in one page of a lane. */
const LANE_PAGE_CARDS = 50;
/** The runs in one page of a task's runs. */
const TASK_RUNS_PAGE = 25;

/** The representation that the request names in `X-Usine-View`, if any. */
const requestedView = Effect.map(
  HttpServerRequest.HttpServerRequest,
  (request) => request.headers["x-usine-view"],
);

/**
 * Reads the task of `item` in the representation that the request names: the web UI's task page
 * for `task`, every run and its results for `full`, and the summary otherwise.
 */
const taskRepresentation = (repository: RepositoryName, item: ItemNumber) =>
  Effect.gen(function* () {
    const view = yield* requestedView;
    const depth = view === "task" || view === "full" ? "results" : "summary";
    const task = yield* fromBackend((backend) => backend.task(repository, item, depth));
    return view === "task" ? taskPage(task) : view === "full" ? task : taskSummary(task);
  });

const projectRepository = (params: { readonly owner: string; readonly repository: string }) =>
  Schema.decodeEffect(RepositoryName)(`${params.owner}/${params.repository}`).pipe(
    Effect.mapError((error) =>
      OperatorHttpError.make({
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
      return yield* OperatorHttpError.make({
        error: "UpgradeError",
        message: "Upgrades are unavailable until the factory is running.",
      });
    return yield* use(upgrades.value).pipe(
      Effect.mapError((error) =>
        OperatorHttpError.make({ error: "UpgradeError", message: error.message }),
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
          const request = yield* HttpServerRequest.HttpServerRequest;
          const permissions = yield* RequestPermissions;
          return yield* changes.stream(request, permissions);
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
          const view = yield* requestedView;
          const overview = yield* fromBackend((backend) => backend.overview);
          return view === "shell"
            ? shellOverview(overview)
            : view === "attention"
              ? attentionOverview(overview)
              : view === "full"
                ? overview
                : summaryOverview(overview);
        }),
      )
      .handle("project", ({ params }) =>
        fromBackend((backend) => backend.overview).pipe(
          Effect.flatMap((overview) => {
            const project = overview.projects.find(({ id }) => id === params.project);
            return project === undefined
              ? Effect.fail(
                  OperatorHttpError.make({
                    error: "BoardProjectNotFoundError",
                    message: `Project ${params.project} was not found.`,
                  }),
                )
              : Effect.map(requestedView, (view) =>
                  view === "board"
                    ? pagedBoard(project)
                    : view === "full"
                      ? project
                      : projectSummary(project),
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
                OperatorHttpError.make({
                  error: "BoardLaneNotFoundError",
                  message: "The project lane was not found.",
                }),
              );
            const page = pageOf(lane.items, query.offset ?? 0, LANE_PAGE_CARDS);
            return Effect.succeed({
              items: page.entries,
              total: page.total,
              nextOffset: page.nextOffset,
            });
          }),
        ),
      )
      .handle("pullRequestFiles", ({ params, query }) =>
        requireProjectRepository(params.project, params.repository).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const files = yield* Effect.serviceOption(GitHubFiles);
              if (Option.isNone(files))
                return yield* OperatorHttpError.make({
                  error: "BackendUnavailableError",
                  message:
                    "Pull request changes are unavailable. Check the GitHub App credentials.",
                });
              const selection =
                query._tag === "PullRequestFiles"
                  ? PullRequestFilesQuery.make({ base: query.base, head: query.head })
                  : CommitRangeFilesQuery.make({ base: query.base, head: query.head });
              const view = yield* requestedView;
              return yield* files.value.read(params.repository, params.item, selection).pipe(
                Effect.map((changes) =>
                  view === "full" ? changes : fileChangesPage(changes, query.offset ?? 0),
                ),
                Effect.tapError((error) =>
                  Effect.logWarning("Pull request files could not be read", {
                    repository: params.repository,
                    item: params.item,
                    errorTag: error._tag,
                  }),
                ),
                Effect.mapError((error) => {
                  if (error._tag === "PullRequestFilesChangedError")
                    return OperatorHttpError.make({ error: error._tag, message: error.message });
                  if (error._tag === "ProjectNotInstalledError")
                    return OperatorHttpError.make({
                      error: error._tag,
                      message: `The GitHub App has lost access to ${error.repository}. Grant the App installation access to the repository, then retry.`,
                    });
                  if (
                    error._tag === "GitHubApiError" &&
                    Option.exists(error.status, (status) => status === 404 || status === 422)
                  )
                    return OperatorHttpError.make({
                      error: "FileChangesNotFoundError",
                      message:
                        query._tag === "PullRequestFiles"
                          ? "The pull request or its selected commits are unavailable on GitHub. Refresh the task to load the latest selection."
                          : "The selected commit comparison is unavailable on GitHub. A commit may be unknown or no longer retained after a force push.",
                    });
                  return error._tag === "InvalidGitHubResponseError"
                    ? OperatorHttpError.make({ error: error._tag, message: error.detail })
                    : operatorFailure(error);
                }),
              );
            }),
          ),
        ),
      )
      .handle("projectTask", ({ params, query }) =>
        requireProjectRepository(params.project, query.repository).pipe(
          Effect.andThen(taskRepresentation(query.repository, params.item)),
        ),
      )
      .handle("moveProjectItem", ({ params, payload }) =>
        requireProjectRepository(params.project, payload.repository).pipe(
          Effect.andThen(
            fromBackend((backend) =>
              backend.moveBoardItem(
                BoardMove.make({
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
        fromBackend((backend) => backend.resetCycleBudget(payload.askId)),
      )
      .handle("detail", ({ params, query }) =>
        Effect.gen(function* () {
          if ((yield* requestedView) === "full")
            return yield* fromBackend((backend) => backend.detail(params.runId, query));
          if (query._tag !== "ColdTranscriptRequest")
            return yield* OperatorHttpError.make({
              error: "InvalidRequestError",
              message:
                "The transcript cursors of detail need `X-Usine-View: full`. Read a transcript page by page with runTranscript.",
            });
          return yield* fromBackend((backend) => backend.brief(params.runId));
        }),
      )
      .handle("runTranscript", ({ params, query }) =>
        fromBackend((backend) =>
          backend.transcriptPage(
            params.runId,
            Option.fromUndefinedOr(query.attempt),
            Option.fromUndefinedOr(query.before),
            query.offset ?? 0,
          ),
        ),
      )
      .handle("runText", ({ params, query }) =>
        fromBackend((backend) =>
          backend.runText(
            params.runId,
            params.part,
            Option.fromUndefinedOr(query.attempt),
            query.offset ?? 0,
          ),
        ),
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
      .handle("applyCiLabels", ({ params, payload }) =>
        fromBackend((backend) => backend.applyCiLabels(params.runId, payload.attemptId)).pipe(
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
              BoardMove.make({ repository, item: params.item, toLane: payload.toLane }),
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
          const task = yield* fromBackend((backend) =>
            backend.task(repository, params.item, "summary"),
          );
          const page = pageOf(task.runs, query.offset ?? 0, TASK_RUNS_PAGE);
          return { runs: page.entries, total: page.total, nextOffset: page.nextOffset };
        }),
      )
      .handle(
        "task",
        Effect.fn("Http.task")(function* ({ params }) {
          const repository = yield* projectRepository(params);
          yield* Effect.annotateCurrentSpan({ repository, item: params.item });
          return yield* taskRepresentation(repository, params.item);
        }),
      )
      .handle(
        "item",
        Effect.fn("Http.item")(function* ({ params, query }) {
          const repository = yield* projectRepository(params);
          yield* Effect.annotateCurrentSpan({ repository, item: params.item });
          return yield* fromBackend((backend) =>
            backend.item(
              repository,
              params.item,
              ItemEntryCursor.make({ entry: query.entry ?? 0, offset: query.offset ?? 0 }),
            ),
          );
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
        Effect.succeed({
          harnesses: catalog.ids,
          harnessDetails: harnessPresentations,
          efforts: EFFORTS,
        }),
      )
      .handle("configurationRepositories", () => configurationRepositories())
      .handle("configurationLabels", ({ params }) =>
        Effect.gen(function* () {
          const grants = yield* RequestPermissions;
          if (permits(grants, "admin", InstanceScope.make()))
            return yield* configurationLabels(params.repository);
          const view = yield* fromBackend((backend) => backend.configuration);
          if (
            !view.repositories.some(
              ({ name }) => name.toLowerCase() === params.repository.toLowerCase(),
            )
          )
            return yield* OperatorHttpError.make({
              error: "AccessDenied",
              message: "You do not have access to this repository.",
            });
          return yield* configurationLabels(params.repository);
        }),
      )
      .handle("configurationRevisions", ({ query }) =>
        fromConfiguration((editor) => editor.list(ConfigurationRevisionQuery.make(query))).pipe(
          Effect.map(revisionPage),
        ),
      )
      .handle("configurationRevision", ({ params }) =>
        fromConfigurationRevision((editor) => editor.revision(params.number)),
      )
      .handle("configurationEntity", ({ params }) =>
        fromConfiguration((editor) => editor.entity(ConfigurationEntityRequest.make(params))),
      )
      .handle("replaceConfigurationEntity", ({ params, payload }) =>
        fromConfigurationRevision((editor) =>
          editor.replace(ConfigurationEntityRequest.make(params), payload),
        ),
      )
      .handle("deleteConfigurationEntity", ({ params, payload }) =>
        fromConfigurationRevision((editor) =>
          editor.remove(ConfigurationEntityRequest.make(params), payload),
        ),
      )
      .handle("revertConfigurationRevision", ({ params, payload }) =>
        fromConfigurationRevision((editor) => editor.revert(params.number, payload)),
      )
      .handle("configuration", () =>
        Effect.gen(function* () {
          const configuration = yield* fromBackend((backend) => backend.configuration);
          return (yield* requestedView) === "full"
            ? configuration
            : configurationSummary(configuration);
        }),
      )
      .handle("desk", () =>
        Effect.gen(function* () {
          const desk = yield* fromBackend((backend) => backend.desk);
          return (yield* requestedView) === "full" ? desk : boundedDesk(desk);
        }),
      )
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
export const apiRoutes = Layer.mergeAll(
  HttpApiBuilder.layer(OperatorApi),
  HttpRouter.add(
    DocumentationApi.endpoints.openapi.method,
    DocumentationApi.endpoints.openapi.path,
    HttpServerResponse.jsonUnsafe(operatorOpenApi()),
  ),
).pipe(
  Layer.provide(conditionalReads.layer),
  Layer.provide(handlers),
  Layer.provide(conversationHandlers),
  Layer.provide(Changes.layer),
  Layer.provide(policy),
  Layer.provide(NodeHttpServer.layerHttpServices),
);

export const staticRoutes = (webRoot: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const assetsRoot = path.resolve(webRoot, "assets");
      const applicationShell = HttpServerResponse.file(path.resolve(webRoot, "index.html"));
      return HttpRouter.addAll([
        HttpRouter.route("GET", "/", applicationShell),
        HttpRouter.route("GET", "/assets/*", (request) =>
          Effect.gen(function* () {
            const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
            const asset = path.resolve(webRoot, pathname.slice(1));
            if (!asset.startsWith(`${assetsRoot}${path.sep}`)) {
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
            const hasFileExtension = path.extname(pathname) !== "";
            if (reservedNamespace || hasFileExtension) {
              yield* Effect.logDebug(
                "Request was not eligible for the application shell fallback",
                {
                  pathname,
                  reason: reservedNamespace ? "reserved-namespace" : "file-extension",
                },
              );
              return HttpServerResponse.text("Not found", { status: 404 });
            }
            yield* Effect.logDebug("Serving the application shell for a client route", {
              pathname,
            });
            return yield* applicationShell;
          }),
        ),
      ]);
    }),
  );

/** The largest request body that the server reads, in bytes. Webhook deliveries set their own. */
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
// A body over the limit fails to read, and each route answers as it does for an unreadable body.
const requestBodyLimit = HttpRouter.middleware(
  (handler) =>
    Effect.provideService(
      handler,
      HttpServerRequest.MaxBodySize,
      ByteSize.fromInputUnsafe(MAX_REQUEST_BODY_BYTES),
    ),
  { global: true },
);

/**
 * Installs the authenticated operator API and the UI on `listener`, replacing its startup
 * responses.
 */
export const serverLayer = (
  backend: Layer.Layer<FactoryBackend>,
  webRoot: string,
  listener: StartupListener,
  auth: AuthServices,
  services:
    | Layer.Layer<
        | ServerUpgrades
        | ConfigurationEditor
        | GitHubApp
        | GitHubPolling
        | GitHubFiles
        | ProviderLogins
      >
    | Layer.Layer<never> = Layer.empty,
  webhooks: Layer.Layer<never, never, HttpRouter.HttpRouter> = Layer.empty,
  setup?: Setup["Service"],
  conversations:
    | Layer.Layer<Conversations | Permissions, never, HttpRouter.HttpRouter>
    | Layer.Layer<never> = Layer.empty,
) => {
  const authenticated = authenticatedRoutes(auth);
  const setupHttp =
    setup === undefined ? undefined : setupRoutes(setup, auth.authentication.origin);
  const routes = Layer.mergeAll(
    setupHttp?.protected.pipe(Layer.provide(authenticated.guard.layer)) ?? Layer.empty,
    setupHttp?.callback ?? Layer.empty,
    apiRoutes.pipe(Layer.provide(authenticated.guard.layer)),
    mcpRoutes(auth.authentication.origins).pipe(
      Layer.provide(authenticated.guard.layer),
      Layer.provide(NodeHttpServer.layerHttpServices),
    ),
    providerRoutes.pipe(Layer.provide(authenticated.guard.layer)),
    staticRoutes(webRoot),
    authenticated.routes,
    webhooks,
    securityMiddleware(auth.authentication),
    requestBodyLimit,
  ).pipe(HttpRouter.provideRequest(Layer.mergeAll(backend, services, conversations)));
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const platform = yield* HttpPlatform.HttpPlatform;
      const handler = yield* HttpRouter.toHttpEffect(routes);
      yield* listener.install(
        handler.pipe(Effect.provideService(HttpPlatform.HttpPlatform, platform)),
      );
    }),
  ).pipe(Layer.provide(NodeHttpServer.layerHttpServices));
};
