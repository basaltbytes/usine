import { jsonKey } from "@usine/core/json-key";
import { fileURLToPath } from "node:url";
import { webRequest } from "../../../tooling/test/http.mts";
import { RunSummaryView, AttemptSummaryView } from "@usine/orchestrator/operator";
import { ChangeBus, changeBusLayer } from "@usine/core/changes";
import {
  RequestPermissions,
  RoleBinding,
  InstanceScope,
  ProjectScope,
  GitHubUserId,
} from "@usine/core/access";
import { operatorPermissions } from "@usine/orchestrator/operator/http";
import { ProviderApi } from "../src/providers/api.ts";
import { providerRoutes } from "../src/providers/http.ts";
import { SetupApi } from "../src/setup/api.ts";
import { setupRoutes } from "../src/setup/http.ts";
import { securityMiddleware } from "../src/security.ts";
import { registerSchema, unregisterSchema, validate } from "@hyperjump/json-schema/openapi-3-1";
import { DocumentationApi, operatorOpenApi } from "../src/openapi.ts";
import { ConfigurationStoreError } from "@usine/config/configuration";
import { ProjectId } from "@usine/core/project";
import { Project } from "@usine/config/project";
import { authenticatedRoutes } from "../src/auth/http.ts";
import { authFixture, localSecret } from "./auth/fixture.ts";
import { UpgradeView } from "@usine/orchestrator/operator/http";
import { ServerUpgrades } from "../src/upgrade/control.ts";
import {
  AttentionKey,
  AttentionRevision,
  type AttentionAcknowledgement,
} from "@usine/engine/attention";
import { Harness, BrainSpec, ModelId } from "@usine/core/agent/brain";
import { TokenCount } from "@usine/core/agent/session";
import { OperatorMessage, ParentTarget } from "@usine/core/attempt/channel";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
// Synchronous Node path callbacks retain the host platform’s path semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join, dirname, basename } from "node:path";
import { NodeHttpPlatform, NodeHttpServer, NodeFileSystem, NodePath } from "@effect/platform-node";
import { LoadedInstance } from "@usine/config/instance";
import { GitHubLabelName } from "@usine/config/label";
import { LaneName, StateLaneSource } from "@usine/config/board";
import { UsineConfig } from "@usine/config/factory";
import { AgentName } from "@usine/core/agent";
import { AttemptId, AttemptTask } from "@usine/core/attempt";
import { CycleBudgetAskId } from "@usine/core/cycle-budget";
import { ItemKey, ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { OperatorLogin } from "@usine/core/operator";
import { EventId } from "@usine/core/event";
import { RunId } from "@usine/core/run";
import { RunAgain } from "@usine/core/run/again";
import { ApprovalSource } from "@usine/core/run/approval";
import { WorkerName } from "@usine/core/worker";
import {
  Claimed,
  LeftoversDiscardRejectedError,
  RunNotFoundError,
  RunOperationRejectedError,
  RunRetryBlockedError,
} from "@usine/engine/engine";
import { CycleBudgetResetRejectedError } from "@usine/engine/cycle-budget";
import { TranscriptSequence } from "@usine/engine/transcript";
import { GitHubItemNotFoundError } from "@usine/github/item-history";
import {
  ApprovalNeed,
  ApprovalView,
  AttemptGitHubChangesView,
  CommentedView,
  LabelRemovedView,
  LabelView,
  RunGitHubChangesView,
  EditAndRetry,
  LoopNotFoundError,
  SessionIntervention,
  BoardLaneId,
  BoardLaneReadOnlyError,
  BoardLaneNotFoundError,
  type BoardMove,
  BoardView,
  ColdTranscriptRequest,
  DeskView,
  EarlierTranscriptRequest,
  FactoryOverview,
  FailedTranscriptView,
  InfraFailureView,
  LoopView,
  ProjectView,
  ReadyOverview,
  RepositoryPollView,
  RunDetailView,
  RunView,
  TranscriptAttemptNotFoundError,
  TranscriptEventView,
  TranscriptPageCursor,
  TailTranscriptRequest,
  type TranscriptRequest,
  OperatorObservation,
  BoardItemNotFoundError,
  TaskCommentView,
  TaskItemView,
  TaskLaneView,
  TaskView,
  BoardItemLink,
  BoardTaskView,
  ReadOnlyBoardLaneView,
  boardRunSummary,
  TaskUsageView,
  ConfigurationView,
  type OperatorConfiguration,
  SettingsView,
  NeedsAttentionView,
  OutcomeCountsView,
  RunStatisticsView,
  StatisticsView,
  type StatisticsWindow,
  WorkerConfigurationView,
  CycleBudgetResetView,
} from "@usine/orchestrator/operator";
import { OperatorApi, OperatorHttpError } from "@usine/orchestrator/operator/http";
import { Context, DateTime, Effect, Layer, Option, Redacted, Schema, FileSystem } from "effect";
import { HttpRouter, FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { beforeAll, afterAll, assert, describe, it } from "@effect/vitest";
import { BackendUnavailableError, FactoryBackend, needsSetupBackendLayer } from "../src/backend.ts";
import { Port, SERVER_HOST } from "../src/cli.ts";
import { apiRoutes, serverLayer, staticRoutes } from "../src/http.ts";

const runId = RunId.make("run-1");
const loopName = LoopName.make("review-issue");
const agentName = AgentName.make("developer");
const repositoryName = RepositoryName.make("basaltbytes/usine");
const config = Schema.decodeEffect(UsineConfig)({
  version: 1,
  repos: [{ name: "basaltbytes/usine" }],
});
const instance = Effect.gen(function* () {
  const fixtureConfig = yield* config;
  return LoadedInstance.make({
    config: fixtureConfig,
    agents: [],
    invalidAgents: [],
    loops: [],
    quarantinedLoops: [],
    warnings: [],
  });
});
const run = RunView.make({
  agentBrain: BrainSpec.make({
    harness: Harness.make("codex"),
    model: ModelId.make("test-model"),
    effort: "high",
  }),
  id: runId,
  itemKey: ItemKey.make("issue:31"),
  loop: loopName,
  repository: repositoryName,
  agent: agentName,
  state: "Waiting",
  loopPaused: true,
  openedAt: "2026-09-01T12:00:00.000Z",
  closedAt: null,
  task: "Review issue 31.",
  attempts: [],
  approval: null,
  runAgain: null,
  resultMessage: null,
  pullRequestUrl: null,
  canApprove: true,
  canRetry: false,
  canResolveFailure: false,
  canCancel: false,
  canRunAgain: false,
});
const detail = RunDetailView.make({
  agentDefinitionChanged: false,
  sessionState: [],
  // An approved Run that the operator ran again, so the detail round trip includes both records.
  run: RunView.make({
    ...run,
    state: "Queued",
    canApprove: false,
    runAgain: RunAgain.make({
      from: RunId.make("run-0"),
      requestedBy: Option.some(OperatorLogin.make("Philippe")),
    }),
    approval: ApprovalView.make({
      approvedAt: "2026-09-01T12:05:00.000Z",
      source: ApprovalSource.make({
        channel: "ui",
        approver: Option.some(OperatorLogin.make("Philippe")),
      }),
    }),
  }),
  eventDedupKey: "issue:31",
  eventPayload: { number: 31 },
  transcript: [
    TranscriptEventView.make({
      attemptId: AttemptId.make("attempt/1"),
      sequence: TranscriptSequence.make(7),
      receivedAt: "2026-09-01T12:00:00.000Z",
      direction: "outbound",
      payload: FailedTranscriptView.make({
        failure: InfraFailureView.make({ message: "Worker disconnected" }),
      }),
    }),
  ],
  earlierTranscript: [
    TranscriptPageCursor.make({
      attemptId: AttemptId.make("attempt/1"),
      before: TranscriptSequence.make(7),
    }),
  ],
});
const overview = ReadyOverview.make({
  projects: [
    ProjectView.make({
      id: ProjectId.make("workspace"),
      name: "Workspace",
      repositories: [repositoryName],
      repository: repositoryName,
      status: "needs-you",
      runs: [
        RunSummaryView.make({
          ...run,
          attempts: run.attempts.map((attempt) => AttemptSummaryView.make(attempt)),
        }),
      ],
      board: BoardView.make({ failures: [], lanes: [] }),
      labels: [],
      preflightFindings: [],
    }),
  ],
  loops: [LoopView.make({ name: loopName, trigger: "issue", agent: agentName, paused: true })],
  needsYou: [
    ApprovalNeed.make({
      id: `approval:${runId}`,
      repository: repositoryName,
      runId,
      loop: loopName,
      item: null,
    }),
  ],
});
const githubChanges = RunGitHubChangesView.make({
  attempts: [
    AttemptGitHubChangesView.make({
      attemptId: AttemptId.make("attempt/1"),
      changes: [
        LabelRemovedView.make({
          at: "2026-10-15T19:55:11.000Z",
          label: LabelView.make({
            name: GitHubLabelName.make("agent-in-progress"),
            color: "fbca04",
            description: "An usine development run is working this issue",
          }),
        }),
        CommentedView.make({
          at: "2026-10-15T19:55:08.000Z",
          url: "https://github.com/basaltbytes/usine/issues/247#issuecomment-6201011438",
        }),
      ],
    }),
  ],
});
const task = TaskView.make({
  repository: repositoryName,
  number: ItemNumber.make(31),
  title: "Review issue 31",
  current: run.itemKey,
  lane: TaskLaneView.make({
    id: BoardLaneId.make("authored:Review"),
    name: LaneName.make("Review"),
  }),
  needsYou: true,
  items: [
    TaskItemView.make({
      itemKey: run.itemKey,
      kind: "issue",
      number: ItemNumber.make(31),
      title: "Review issue 31",
      url: "https://github.com/basaltbytes/usine/issues/31",
      state: "issue-open",
      labels: [GitHubLabelName.make("review")],
      conflicting: false,
    }),
  ],
  runs: [run],
  comments: [
    TaskCommentView.make({
      runId,
      kind: "issue-comment",
      url: "https://github.com/basaltbytes/usine/issues/31#issuecomment-1",
      postedAt: "2026-09-01T12:20:00.000Z",
      attemptEndedAt: "2026-09-01T12:30:00.000Z",
    }),
  ],
});
const desk = DeskView.make({
  running: [],
  notMoving: [],
  lastOutcomes: [],
  workers: [],
  polls: [RepositoryPollView.make({ repository: repositoryName, polledAt: null })],
});
const statisticsOf = (window: StatisticsWindow) =>
  StatisticsView.make({
    window,
    from: "2026-09-01T00:00:00.000Z",
    to: "2026-09-01T12:00:00.000Z",
    bucket: "day",
    loops: [],
    tasks: [],
    medianMillis: null,
    periods: [],
    firstTimeRight: 0,
    operatorActions: 0,
    time: null,
    tokens: null,
    untimed: null,
    unmetered: 0,
  });
const runStatisticsOf = (window: StatisticsWindow) =>
  RunStatisticsView.make({
    window,
    from: "2026-09-01T00:00:00.000Z",
    to: "2026-09-01T12:00:00.000Z",
    bucket: "day",
    runs: OutcomeCountsView.make({ succeeded: 0, failed: 0, canceled: 0 }),
    runTime: null,
    attemptTime: null,
    unmeasuredAttempts: 0,
    throughput: [],
    loops: [],
    agents: [],
    brains: [],
    queueWait: [],
    attemptsPerRun: [],
    utilization: [],
    needsAttention: NeedsAttentionView.make({
      approvals: 0,
      failures: 0,
      periods: [],
      approvalWait: null,
      retryWait: null,
      resolutionWait: null,
      failureWait: null,
    }),
  });
const observation: OperatorObservation["Service"] = {
  overview: () => Effect.succeed(overview),
  desk: () => Effect.succeed(desk),
  statistics: (_instance, window) => Effect.succeed(statisticsOf(window)),
  runStatistics: (_instance, window) => Effect.succeed(runStatisticsOf(window)),
  detail: () => Effect.succeed(detail),
  task: () => Effect.succeed(task),
};
const configurationView = ConfigurationView.make({
  projects: [
    Project.make({
      id: ProjectId.make("workspace"),
      name: "Workspace",
      repositories: [repositoryName],
    }),
  ],
  labels: [],
  loops: [],
  quarantinedLoops: [],
  agents: [],
  invalidAgents: [],
  workers: [
    WorkerConfigurationView.make({
      name: WorkerName.make("local"),
      kind: "local",
      maxConcurrentAttempts: 1,
      destination: null,
      port: null,
      identityFile: null,
      root: null,
      gateway: null,
      container: null,
      slots: null,
      prerequisites: null,
      harnesses: [],
    }),
  ],
  removedWorkers: [],
  repositories: [],
  settings: SettingsView.make({
    pollInterval: 60,
    maxChildren: 4,
    maxAttemptMinutes: null,
    maxAttemptTokens: null,
    parentModel: null,
    parentEffort: null,
    operator: null,
    webhooks: "off",
    lastHintAt: null,
    webhooksPublicUrl: null,
    tracing: null,
  }),
});
const configuration: OperatorConfiguration["Service"] = {
  view: () => Effect.succeed(configurationView),
};
const dismissed: Array<AttentionAcknowledgement> = [];
const makeBackend = Effect.gen(function* () {
  const fixtureInstance = yield* instance;
  return needsSetupBackendLayer(
    { get: Effect.succeed(fixtureInstance) },
    "SecretsFileError",
    observation,
    configuration,
    {
      list: Effect.succeed(dismissed),
      prune: () => Effect.die("unused"),
      dismiss: (acknowledgement) =>
        Effect.sync(() => {
          dismissed.push(acknowledgement);
        }),
      undo: (key) =>
        Effect.sync(() => {
          const index = dismissed.findIndex(
            (entry) => entry.id === key.id && entry.revision === key.revision,
          );
          if (index >= 0) dismissed.splice(index, 1);
        }),
    },
  );
});
const makeApp = (backend: Effect.Success<typeof makeBackend>) =>
  HttpRouter.toWebHandler(apiRoutes.pipe(HttpRouter.provideRequest(backend)), {
    disableLogger: true,
  });

let backend: Effect.Success<typeof makeBackend>;
let app: ReturnType<typeof makeApp>;
beforeAll(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      backend = yield* makeBackend;
      app = makeApp(backend);
    }),
  ),
);

afterAll(() => app.dispose());

it.live(
  "publishes a valid OpenAPI document for every API route and protects non-public routes",
  () =>
    Effect.gen(function* () {
      const fixtureBackend = backend;
      const services = yield* authFixture();
      const auth = authenticatedRoutes(services);
      const setup = setupRoutes(
        {
          running: false,
          status: Effect.die("unused"),
          activate: Effect.die("unused"),
          changed: Effect.never,
          begin: () => Effect.die("unused"),
          exchange: () => Effect.die("unused"),
          restore: () => Effect.die("unused"),
        },
        services.authentication.origin,
      );
      const secured = HttpRouter.toWebHandler(
        Layer.mergeAll(
          apiRoutes.pipe(Layer.provide(auth.guard.layer)),
          auth.routes,
          setup.protected.pipe(Layer.provide(auth.guard.layer)),
          providerRoutes.pipe(Layer.provide(auth.guard.layer)),
          setup.callback,
          securityMiddleware(services.authentication),
        ).pipe(HttpRouter.provideRequest(fixtureBackend)),
        { disableLogger: true },
      );
      yield* Effect.addFinalizer(() => Effect.promise(() => secured.dispose()));
      const authorizedRead = yield* Effect.promise(() =>
        secured.handler(
          new Request("http://127.0.0.1/api/overview", {
            headers: { authorization: `Bearer ${localSecret}` },
          }),
        ),
      );
      assert.equal(authorizedRead.headers.get("cache-control"), "private, no-cache");
      const validator = authorizedRead.headers.get("etag");
      assert(validator !== null);
      const unauthorizedRead = yield* Effect.promise(() =>
        secured.handler(
          new Request("http://127.0.0.1/api/overview", {
            headers: { "if-none-match": validator },
          }),
        ),
      );
      assert.equal(unauthorizedRead.status, 401);
      const sessionRead = yield* Effect.promise(() =>
        secured.handler(
          new Request("http://127.0.0.1/api/auth/session", {
            headers: { authorization: `Bearer ${localSecret}` },
          }),
        ),
      );
      assert.equal(sessionRead.headers.get("cache-control"), "no-store");
      assert.equal(sessionRead.headers.get("etag"), null);
      const publicRoutes = new Set([
        "GET /api/health",
        "GET /api/version",
        "GET /api/ready",
        "GET /api/openapi.json",
        "GET /api/auth/info",
        "GET /api/auth/github",
        "GET /api/auth/callback",
        "GET /api/setup/callback",
        "POST /api/auth/device",
        "POST /api/auth/device/poll",
        "POST /api/auth/link/consume",
      ]);
      const endpoints = [
        ...Object.values(OperatorApi.groups).flatMap((group) => Object.values(group.endpoints)),
        ...auth.endpoints,
        ...Object.values(DocumentationApi.endpoints),
        ...Object.values(SetupApi.endpoints),
        ...Object.values(ProviderApi.endpoints),
      ];
      const response = yield* Effect.promise(() =>
        secured.handler(new Request("http://127.0.0.1/api/openapi.json")),
      );
      assert.equal(response.status, 200);
      assert.include(response.headers.get("content-type"), "application/json");
      const document = yield* Effect.promise(() => response.json());
      const validation = yield* Effect.promise(() =>
        validate("https://spec.openapis.org/oas/3.1/schema-base", document, "BASIC"),
      );
      const decodedValue1 = jsonKey(validation);
      assert.isTrue(validation.valid, decodedValue1);
      const generated = operatorOpenApi();
      assert.deepEqual(document, generated);
      const committed = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.readFileString(
          fileURLToPath(new URL("../../docs/public/openapi.json", import.meta.url)),
        ),
      );
      const json1 = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(committed).pipe(
        Effect.orDie,
      );
      assert.deepEqual(document, json1);
      const documentedRoutes = Object.entries(generated.paths).flatMap(([path, methods]) =>
        Object.entries(methods).map(([method, operation]) => {
          assert.property(operation, "summary", `${method} ${path}`);
          assert.property(operation, "description", `${method} ${path}`);
          return `${method.toUpperCase()} ${path}`;
        }),
      );
      assert.sameMembers(
        documentedRoutes,
        endpoints.map(({ method, path }) => `${method} ${path.replace(/:([^/]+)/gu, "{$1}")}`),
      );
      assert.deepEqual(generated.paths["/api/openapi.json"]?.get?.security, []);
      assert.deepEqual(generated.paths["/api/version"]?.get?.security, []);
      assert.deepEqual(generated.paths["/api/ready"]?.get?.security, []);
      assert.deepEqual(generated.paths["/api/setup/callback"]?.get?.security, []);
      assert.deepEqual(generated.paths["/api/overview"]?.get?.security, [
        { bearer: [] },
        { session: [] },
      ]);
      const schemaId = "https://usine.example/openapi-test";
      registerSchema(document, schemaId, "https://spec.openapis.org/oas/3.1/dialect/base");
      yield* Effect.addFinalizer(() => Effect.sync(() => unregisterSchema(schemaId)));
      const currentLink = yield* services.authentication.link;
      const link = new URL(currentLink);
      const session = yield* services.authentication.consumeLink(
        new URLSearchParams(link.hash.slice(1)).get("link") ?? "",
      );
      for (const endpoint of endpoints) {
        const path = endpoint.path.replace(/:[^/]+/gu, "test");
        const schemaPath = encodeURIComponent(
          endpoint.path.replace(/:([^/]+)/gu, "{$1}").replaceAll("/", "~1"),
        );
        const responseSchema = `${schemaId}#/paths/${schemaPath}/${endpoint.method.toLowerCase()}/responses/403/content/application~1json/schema`;
        const refused = yield* Effect.promise(() =>
          secured.handler(
            new Request(`http://127.0.0.1${path}`, {
              method: endpoint.method,
              headers: {
                origin: "https://unknown.example",
                authorization: `Bearer ${localSecret}`,
              },
            }),
          ),
        );
        assert.equal(refused.status, 403);
        const refusedBody = yield* Effect.promise(() => refused.json());
        const refusedValidation = yield* Effect.promise(() =>
          validate(responseSchema, refusedBody),
        );
        assert.isTrue(
          refusedValidation.valid,
          `${endpoint.method} ${path}: ${jsonKey(refusedBody)}`,
        );
        if (publicRoutes.has(`${endpoint.method} ${endpoint.path}`)) continue;
        for (const spelling of [
          path,
          path.replace("/api/", "/API/"),
          `/${path}`,
          path.replace("/api/", "/%61pi/"),
        ]) {
          const response = yield* Effect.promise(() =>
            secured.handler(
              new Request(`http://127.0.0.1${spelling}`, {
                method: endpoint.method,
                headers: { "x-forwarded-for": "127.0.0.1" },
              }),
            ),
          );
          assert.equal(response.status, 401, `${endpoint.method} ${spelling}`);
        }
        if (endpoint.method !== "GET") {
          for (const csrf of [undefined, "stale-csrf"]) {
            const headers = new Headers({
              cookie: `usine_session=${Redacted.value(session.secret)}`,
            });
            if (csrf !== undefined) headers.set("x-usine-csrf", csrf);
            const response = yield* Effect.promise(() =>
              secured.handler(
                new Request(`http://127.0.0.1${path}`, {
                  method: endpoint.method,
                  headers,
                }),
              ),
            );
            assert.equal(response.status, 403);
            const body = yield* Effect.promise(() => response.json());
            const result = yield* Effect.promise(() => validate(responseSchema, body));
            assert.isTrue(result.valid, `${endpoint.method} ${path}: ${jsonKey(body)}`);
          }
        }
      }
      const forbiddenSchema = `${schemaId}#/paths/~1api~1runs~1%7BrunId%7D~1cancel/post/responses/403/content/application~1json/schema`;
      const crossSite = yield* Effect.promise(() =>
        validate(forbiddenSchema, {
          error: "CrossSiteRequestError",
          message: "Origin is not allowed",
        }),
      );
      assert.isTrue(crossSite.valid);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it("publishes optional transcript cursor parameters with their domain constraints", () => {
  const parameters = operatorOpenApi().paths["/api/runs/{runId}"]?.get?.parameters;
  assert.isDefined(parameters);
  assert.sameMembers(
    parameters.map(({ name }) => name),
    ["runId", "after", "before", "attempt"],
  );
  const cursors = parameters.filter((parameter) => parameter.in === "query");
  assert.sameMembers(
    cursors.map(({ name }) => name),
    ["after", "before", "attempt"],
  );
  for (const cursor of cursors) {
    assert.isFalse(cursor.required);
    assert.deepEqual(
      cursor.schema,
      cursor.name === "attempt"
        ? { type: "string", minLength: 1 }
        : { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    );
  }
});

describe("operator HTTP API", () => {
  it.live("reports the running release and validates upgrade requests before accepting them", () =>
    Effect.gen(function* () {
      const requested: Array<string> = [];
      const upgradeBackend = Layer.succeed(ServerUpgrades, {
        cancel: Effect.sync(() => {
          requested.push("cancel");
        }),
        polling: Effect.never,
        status: Effect.succeed(
          UpgradeView.make({
            running: "1.0.0",
            channel: "next",
            mode: "propose",
            supported: true,
            available: null,
            phase: "idle",
            message: null,
            outcome: null,
          }),
        ),
        request: (input) =>
          Effect.sync(() => {
            requested.push(input.timing);
          }),
      });
      const auth = yield* authFixture().pipe(Effect.scoped);
      const upgradeApp = HttpRouter.toWebHandler(
        apiRoutes.pipe(
          Layer.provide(authenticatedRoutes(auth).guard.layer),
          HttpRouter.provideRequest(Layer.merge(backend, upgradeBackend)),
        ),
        { disableLogger: true },
      );
      const authorization = { authorization: `Bearer ${localSecret}` };
      try {
        for (const path of ["/api/version", "/API/version", "//api/version", "/%61pi/version"]) {
          const version = yield* Effect.promise(() =>
            upgradeApp.handler(new Request(`http://localhost${path}`)),
          );
          assert.strictEqual(version.status, 200);
          const actual1 = yield* Effect.promise(() => version.json());
          assert.strictEqual(actual1, "1.0.0");
        }
        const status = yield* Effect.promise(() =>
          upgradeApp.handler(
            new Request("http://localhost/api/upgrade", { headers: authorization }),
          ),
        );
        const actual2 = yield* Effect.promise(() => status.json());
        assert.strictEqual(
          (yield* Schema.decodeUnknownEffect(UpgradeView)(actual2)).channel,
          "next",
        );
        const invalid = yield* Effect.promise(() =>
          upgradeApp.handler(
            new Request("http://localhost/api/upgrade", {
              headers: authorization,
              method: "POST",
              body: jsonKey({ timing: "tomorrow" }),
            }),
          ),
        );
        assert.strictEqual(invalid.status, 400);
        const invalidVersion = yield* Effect.promise(() =>
          upgradeApp.handler(
            new Request("http://localhost/api/upgrade", {
              headers: authorization,
              method: "POST",
              body: jsonKey({ timing: "now", version: "1.0.0-01" }),
            }),
          ),
        );
        assert.strictEqual(invalidVersion.status, 400);

        assert.deepStrictEqual(requested, []);
        const accepted = yield* Effect.promise(() =>
          upgradeApp.handler(
            new Request("http://localhost/api/upgrade", {
              headers: authorization,
              method: "POST",
              body: jsonKey({ timing: "idle" }),
            }),
          ),
        );
        assert.strictEqual(accepted.status, 200);
        assert.deepStrictEqual(requested, ["idle"]);
        const canceled = yield* Effect.promise(() =>
          upgradeApp.handler(
            new Request("http://localhost/api/upgrade", {
              headers: authorization,
              method: "DELETE",
            }),
          ),
        );
        assert.strictEqual(canceled.status, 200);
        assert.deepStrictEqual(requested, ["idle", "cancel"]);
      } finally {
        yield* Effect.promise(() => upgradeApp.dispose());
      }
    }),
  );

  it.live(
    "records dismissals and undo during setup without accepting client-supplied operator identity",
    () =>
      Effect.gen(function* () {
        const payload = { id: "config-file:loop", revision: "invalid agent" };
        const send = (path: string, body: Schema.Json) =>
          app.handler(
            new Request(`http://localhost/api/attention/${path}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: jsonKey(body),
            }),
          );
        const invalid = yield* Effect.promise(() =>
          send("dismiss", { ...payload, dismissedBy: "someone-else" }),
        );
        assert.strictEqual(invalid.status, 400);
        assert.strictEqual(dismissed.length, 0);
        const response = yield* Effect.promise(() => send("dismiss", payload));
        assert.strictEqual(response.status, 200);
        const saved = dismissed[0];
        assert(saved !== undefined);
        assert.strictEqual(saved.id, payload.id);
        assert.strictEqual(saved.revision, payload.revision);
        assert.deepStrictEqual(saved.dismissedBy, (yield* instance).config.operator);
        assert(DateTime.toEpochMillis(saved.dismissedAt) > 0);
        const undo = yield* Effect.promise(() => send("undo", payload));
        assert.strictEqual(undo.status, 200);
        assert.strictEqual(dismissed.length, 0);
      }),
  );

  it.live(
    "preserves durable observation in needs-setup mode while intervention remains unavailable",
    () =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          app.handler(new Request("http://localhost/api/overview")),
        );
        assert.strictEqual(response.status, 200);
        const actual3 = yield* Effect.promise(() => response.json());
        const body = yield* Schema.decodeUnknownEffect(FactoryOverview)(actual3);
        assert.strictEqual(body._tag, "NeedsSetup");
        assert.strictEqual(body.projects[0]?.runs[0]?.id, runId);
        assert.strictEqual(body.loops[0]?.paused, true);

        const deskResponse = yield* Effect.promise(() =>
          app.handler(new Request("http://localhost/api/desk")),
        );
        assert.strictEqual(deskResponse.status, 200);
        const actual4 = yield* Effect.promise(() => deskResponse.json());
        const deskBody = yield* Schema.decodeUnknownEffect(DeskView)(actual4);
        assert.deepStrictEqual(
          deskBody.polls.map(({ polledAt }) => polledAt),
          [null],
        );

        const runResponse = yield* Effect.promise(() =>
          app.handler(new Request(`http://localhost/api/runs/${runId}`)),
        );
        assert.strictEqual(runResponse.status, 200);
        assert.strictEqual(
          (yield* Effect.promise(() => runResponse.json())).eventDedupKey,
          "issue:31",
        );

        const taskResponse = yield* Effect.promise(() =>
          app.handler(new Request("http://localhost/api/projects/basaltbytes/usine/tasks/31")),
        );
        assert.strictEqual(taskResponse.status, 200);
        const actual5 = yield* Effect.promise(() => taskResponse.json());
        const actual28 = yield* Schema.decodeUnknownEffect(TaskView)(actual5);
        assert.deepStrictEqual(actual28, task);

        for (const [search, window] of [
          ["?window=7d", "7d"],
          ["", "30d"],
          ["?window=all&window=7d", "all"],
        ] as const) {
          const statisticsResponse = yield* Effect.promise(() =>
            app.handler(new Request(`http://localhost/api/statistics${search}`)),
          );
          assert.strictEqual(statisticsResponse.status, 200, search);
          const actual6 = yield* Effect.promise(() => statisticsResponse.json());
          assert.strictEqual(
            (yield* Schema.decodeUnknownEffect(StatisticsView)(actual6)).window,
            window,
          );
          const runStatisticsResponse = yield* Effect.promise(() =>
            app.handler(new Request(`http://localhost/api/statistics/runs${search}`)),
          );
          assert.strictEqual(runStatisticsResponse.status, 200, search);
          const actual7 = yield* Effect.promise(() => runStatisticsResponse.json());
          assert.strictEqual(
            (yield* Schema.decodeUnknownEffect(RunStatisticsView)(actual7)).window,
            window,
          );
        }
        const unknownWindow = yield* Effect.promise(() =>
          app.handler(new Request("http://localhost/api/statistics?window=90d")),
        );
        assert.strictEqual(unknownWindow.status, 400);

        for (const search of [
          "after=2&after=0",
          "attempt=a&attempt=b&before=2",
          "after=2&unrelated=x",
        ]) {
          const repeated = yield* Effect.promise(() =>
            app.handler(new Request(`http://localhost/api/runs/${runId}?${search}`)),
          );
          assert.strictEqual(repeated.status, 200, search);
        }

        const action = yield* Effect.promise(() =>
          app.handler(
            new Request(`http://localhost/api/runs/${runId}/approve`, { method: "POST" }),
          ),
        );
        assert.strictEqual(action.status, 503);
        const actual8 = yield* Effect.promise(() => action.json());
        assert.deepStrictEqual(actual8, {
          error: "BackendUnavailableError",
          message: "The GitHub App is not set up. Set it up to use operator actions.",
        });

        const configurationResponse = yield* Effect.promise(() =>
          app.handler(new Request("http://localhost/api/configuration")),
        );
        assert.strictEqual(configurationResponse.status, 200);
        const actual9 = yield* Effect.promise(() => configurationResponse.json());
        const actual29 = yield* Schema.decodeUnknownEffect(ConfigurationView)(actual9);
        assert.deepStrictEqual(actual29, configurationView);

        const invalidCursor = yield* Effect.promise(() =>
          app.handler(new Request(`http://localhost/api/runs/${runId}?after=0`)),
        );
        assert.strictEqual(invalidCursor.status, 400);
        assert.strictEqual(
          (yield* Effect.promise(() => invalidCursor.json())).error,
          "SchemaError",
        );

        for (const search of [
          "before=2",
          "attempt=a",
          "after=2&before=3",
          "after=2&attempt=a",
          "after=2&attempt=a&before=3",
        ]) {
          const invalid = yield* Effect.promise(() =>
            app.handler(new Request(`http://localhost/api/runs/${runId}?${search}`)),
          );
          assert.strictEqual(invalid.status, 400, search);
          assert.strictEqual((yield* Effect.promise(() => invalid.json())).error, "SchemaError");
        }
      }),
  );

  it.live("maps typed engine errors onto operator-readable statuses", () =>
    Effect.gen(function* () {
      let moved: BoardMove | undefined;
      const rejecting = Layer.succeed(FactoryBackend)({
        runWorkerPreflight: () => Effect.die("unused"),
        resolveFailure: () => Effect.void,
        agents: Effect.succeed([]),
        editAndRetry: () => Effect.void,
        runAgain: (id) =>
          id === runId
            ? Effect.fail(
                RunOperationRejectedError.make({
                  runId: id,
                  operation: "runAgain",
                  state: "Running",
                }),
              )
            : Effect.fail(
                LoopNotFoundError.make({
                  loop: loopName,
                  message: `Run ${id} cannot run again: loop "${loopName}" is not loaded.`,
                }),
              ),
        intervene: () => Effect.void,
        overview: Effect.succeed(overview),
        detail: (id, request) =>
          request._tag === "EarlierTranscriptRequest"
            ? Effect.fail(
                TranscriptAttemptNotFoundError.make({ runId: id, attemptId: request.attemptId }),
              )
            : Effect.fail(RunNotFoundError.make({ runId: id })),
        githubChanges: () =>
          Effect.fail(
            GitHubItemNotFoundError.make({
              operation: "fetch-item-timeline",
              item: 247,
              message:
                "Issue or pull request basaltbytes/usine#247 was not found on GitHub. It was deleted or transferred, or the GitHub App can no longer read it.",
            }),
          ),
        approve: (id: RunId) =>
          Effect.fail(
            RunOperationRejectedError.make({ runId: id, operation: "approve", state: "Running" }),
          ),
        dismissNeed: () => Effect.void,
        undoDismissNeed: () => Effect.void,
        resetCycleBudget: () =>
          Effect.succeed(CycleBudgetResetView.make({ replayedCiFixEventIds: [] })),
        retry: (id: RunId) =>
          Effect.fail(
            RunRetryBlockedError.make({
              runId: id,
              openRunId: RunId.make("run-open"),
              message: `Cannot retry run ${id}: run run-open of loop "fix-ci" is open on the same item. Cancel run run-open, or try again after it closes.`,
            }),
          ),
        cancel: (id) =>
          Effect.fail(
            RunOperationRejectedError.make({ runId: id, operation: "cancel", state: "Failed" }),
          ),
        discardLeftovers: () => Effect.void,
        moveBoardItem: (move) => {
          if (move.toLane === "Ready")
            return Effect.fail(
              BoardLaneNotFoundError.make({ repository: move.repository, lane: move.toLane }),
            );
          if (move.toLane === "proposed:ready")
            return Effect.fail(
              BoardLaneReadOnlyError.make({ repository: move.repository, lane: move.toLane }),
            );
          return Effect.sync(() => void (moved = move));
        },
        pause: () => Effect.void,
        unpause: () => Effect.void,
        task: (repository, item) => Effect.fail(BoardItemNotFoundError.make({ repository, item })),
        configuration: Effect.succeed(configurationView),
        desk: Effect.succeed(desk),
        statistics: (window) => Effect.succeed(statisticsOf(window)),
        runStatistics: (window) => Effect.succeed(runStatisticsOf(window)),
      });
      const rejectingApp = HttpRouter.toWebHandler(
        apiRoutes.pipe(HttpRouter.provideRequest(rejecting)),
        { disableLogger: true },
      );
      try {
        const missing = yield* Effect.promise(() =>
          rejectingApp.handler(new Request("http://localhost/api/runs/run-2")),
        );
        assert.strictEqual(missing.status, 404);
        const actual10 = yield* Effect.promise(() => missing.json());
        assert.deepStrictEqual(actual10, {
          error: "RunNotFoundError",
          message: "Run run-2 was not found.",
        });

        const offBoard = yield* Effect.promise(() =>
          rejectingApp.handler(
            new Request("http://localhost/api/projects/basaltbytes/usine/tasks/9999"),
          ),
        );
        assert.strictEqual(offBoard.status, 404);
        const actual11 = yield* Effect.promise(() => offBoard.json());
        assert.deepStrictEqual(actual11, {
          error: "BoardItemNotFoundError",
          message: "Item basaltbytes/usine#9999 was not found on the board.",
        });

        const gone = yield* Effect.promise(() =>
          rejectingApp.handler(new Request(`http://localhost/api/runs/${runId}/github-changes`)),
        );
        assert.strictEqual(gone.status, 404);
        const actual12 = yield* Effect.promise(() => gone.json());
        assert.deepStrictEqual(actual12, {
          error: "GitHubItemNotFoundError",
          message:
            "Issue or pull request basaltbytes/usine#247 was not found on GitHub. It was deleted or transferred, or the GitHub App can no longer read it.",
        });

        const rejected = yield* Effect.promise(() =>
          rejectingApp.handler(
            new Request(`http://localhost/api/runs/${runId}/approve`, { method: "POST" }),
          ),
        );
        assert.strictEqual(rejected.status, 409);
        const actual13 = yield* Effect.promise(() => rejected.json());
        assert.deepStrictEqual(actual13, {
          error: "RunOperationRejectedError",
          message: `Cannot approve run ${runId} while it is running.`,
        });

        const cancel = yield* Effect.promise(() =>
          rejectingApp.handler(
            new Request(`http://localhost/api/runs/${runId}/cancel`, { method: "POST" }),
          ),
        );
        assert.strictEqual(cancel.status, 409);
        const actual14 = yield* Effect.promise(() => cancel.json());
        assert.deepStrictEqual(actual14, {
          error: "RunOperationRejectedError",
          message: `Cannot cancel run ${runId} while it is failed.`,
        });

        const blocked = yield* Effect.promise(() =>
          rejectingApp.handler(
            new Request(`http://localhost/api/runs/${runId}/retry`, { method: "POST" }),
          ),
        );
        assert.strictEqual(blocked.status, 409);
        const actual15 = yield* Effect.promise(() => blocked.json());
        assert.deepStrictEqual(actual15, {
          error: "RunRetryBlockedError",
          message: `Cannot retry run ${runId}: run run-open of loop "fix-ci" is open on the same item. Cancel run run-open, or try again after it closes.`,
        });

        const json2 = jsonKey({
          task: "Look again",
          agent: agentName,
        });
        const edit = json2;
        const open = yield* Effect.promise(() =>
          rejectingApp.handler(
            new Request(`http://localhost/api/runs/${runId}/run-again`, {
              method: "POST",
              body: edit,
            }),
          ),
        );
        assert.strictEqual(open.status, 409);
        const actual16 = yield* Effect.promise(() => open.json());
        assert.deepStrictEqual(actual16, {
          error: "RunOperationRejectedError",
          message: `Run ${runId} is running. Only a succeeded or canceled run can run again.`,
        });
        const retired = yield* Effect.promise(() =>
          rejectingApp.handler(
            new Request("http://localhost/api/runs/run-3/run-again", {
              method: "POST",
              body: edit,
            }),
          ),
        );
        assert.strictEqual(retired.status, 404);
        const actual17 = yield* Effect.promise(() => retired.json());
        assert.deepStrictEqual(actual17, {
          error: "LoopNotFoundError",
          message: `Run run-3 cannot run again: loop "${loopName}" is not loaded.`,
        });

        const wrongAttempt = AttemptId.make("attempt-from-another-run");
        const earlier = yield* Effect.promise(() =>
          rejectingApp.handler(
            new Request(`http://localhost/api/runs/${runId}?attempt=${wrongAttempt}&before=2`),
          ),
        );
        assert.strictEqual(earlier.status, 404);
        const actual18 = yield* Effect.promise(() => earlier.json());
        assert.deepStrictEqual(actual18, {
          error: "TranscriptAttemptNotFoundError",
          message: `Attempt ${wrongAttempt} does not belong to run ${runId}.`,
        });

        const move = yield* Effect.promise(() =>
          rejectingApp.handler(
            new Request("http://localhost/api/projects/basaltbytes/usine/items/31/lane", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: jsonKey({ toLane: BoardLaneId.make("authored:Review") }),
            }),
          ),
        );
        assert.strictEqual(move.status, 200);
        assert.strictEqual(moved?.repository, repositoryName);
        assert.strictEqual(moved?.item, 31);
        assert.strictEqual(moved?.toLane, "authored:Review");
        const unknownLane = yield* Effect.promise(() =>
          rejectingApp.handler(
            new Request("http://localhost/api/projects/basaltbytes/usine/items/31/lane", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: jsonKey({ toLane: "Ready" }),
            }),
          ),
        );
        assert.strictEqual(unknownLane.status, 404);
        const actual19 = yield* Effect.promise(() => unknownLane.json());
        assert.deepStrictEqual(actual19, {
          error: "BoardLaneNotFoundError",
          message: 'Lane "Ready" was not found on the board.',
        });
        const proposed = yield* Effect.promise(() =>
          rejectingApp.handler(
            new Request("http://localhost/api/projects/basaltbytes/usine/items/31/lane", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: jsonKey({ toLane: "proposed:ready" }),
            }),
          ),
        );
        assert.strictEqual(proposed.status, 409);
        const actual20 = yield* Effect.promise(() => proposed.json());
        const refusal = yield* Schema.decodeUnknownEffect(OperatorHttpError)(actual20);
        assert.strictEqual(refusal.error, "BoardLaneReadOnlyError");
        assert.match(refusal.message, /read-only/i);
        assert.match(refusal.message, /usine\.yaml/);

        // Authored fields are validated strictly, although JSON is accepted regardless of
        // Content-Type.
        for (const body of ["{", '{"toLane":"authored:Review","typo":true}', '{"toLane":42}']) {
          const invalid = yield* Effect.promise(() =>
            rejectingApp.handler(
              new Request("http://localhost/api/projects/basaltbytes/usine/items/31/lane", {
                method: "POST",
                body,
              }),
            ),
          );
          assert.strictEqual(invalid.status, 400);
          assert.strictEqual(
            (yield* Effect.promise(() => invalid.json())).error,
            "InvalidRequestError",
          );
        }
        const simplePost = yield* Effect.promise(() =>
          rejectingApp.handler(
            new Request("http://localhost/api/projects/basaltbytes/usine/items/31/lane", {
              method: "POST",
              body: '{"toLane":"authored:Done"}',
            }),
          ),
        );
        assert.strictEqual(simplePost.status, 200);
        assert.strictEqual(moved?.toLane, "authored:Done");
      } finally {
        yield* Effect.promise(() => rejectingApp.dispose());
      }
    }),
  );

  it.live(
    "round-trips the derived client through a listening server for reads, interventions, cursors, and typed failures",
    () =>
      Effect.gen(function* () {
        const observed: Array<TranscriptRequest> = [];
        const interventions: Array<string> = [];
        const record = (operation: string) => Effect.sync(() => void interventions.push(operation));
        const edits: Array<EditAndRetry> = [];
        const againEdits: Array<EditAndRetry> = [];
        const opened = Claimed.make({
          eventId: EventId.make("run-again-event"),
          runId: RunId.make("run-2"),
        });
        const inputs: Array<SessionIntervention> = [];
        const live = Layer.succeed(FactoryBackend)({
          runWorkerPreflight: () => Effect.die("unused"),
          resolveFailure: (id, attemptId) =>
            attemptId === "attempt/1"
              ? record(`resolve:${id}:${attemptId}`)
              : Effect.fail(
                  RunOperationRejectedError.make({
                    runId: id,
                    operation: "resolveFailure",
                    state: "Failed",
                  }),
                ),
          agents: Effect.succeed([agentName]),
          editAndRetry: (_id, edit) =>
            Effect.sync(() => {
              edits.push(edit);
            }),
          runAgain: (_id, edit) =>
            Effect.sync(() => {
              againEdits.push(edit);
              return opened;
            }),
          intervene: (_id, input) =>
            Effect.sync(() => {
              inputs.push(input);
            }),
          overview: Effect.succeed(overview),
          detail: (id, request) => {
            if (id !== runId) return Effect.fail(RunNotFoundError.make({ runId: id }));
            if (request._tag === "EarlierTranscriptRequest" && request.attemptId !== "attempt/1") {
              return Effect.fail(
                TranscriptAttemptNotFoundError.make({ runId: id, attemptId: request.attemptId }),
              );
            }
            return Effect.sync(() => {
              observed.push(request);
              return detail;
            });
          },
          githubChanges: () => Effect.succeed(githubChanges),
          approve: (id) =>
            id === runId
              ? record(`approve:${id}`)
              : Effect.fail(
                  RunOperationRejectedError.make({
                    runId: id,
                    operation: "approve",
                    state: "Running",
                  }),
                ),
          dismissNeed: (key) => record(`dismiss:${key.id}:${key.revision}`),
          undoDismissNeed: (key) => record(`undo:${key.id}:${key.revision}`),
          resetCycleBudget: (id) =>
            id === "current-ask"
              ? record(`reset:${id}`).pipe(
                  Effect.as(
                    CycleBudgetResetView.make({
                      replayedCiFixEventIds: [EventId.make("blocked-ci-fix")],
                    }),
                  ),
                )
              : Effect.fail(CycleBudgetResetRejectedError.make({ askId: id })),
          retry: (id) => record(`retry:${id}`),
          cancel: (id) => record(`cancel:${id}`),
          discardLeftovers: (worker) =>
            Effect.fail(LeftoversDiscardRejectedError.make({ worker, running: 2 })),
          pause: (loop) =>
            loop === loopName
              ? record(`pause:${loop}`)
              : Effect.fail(BackendUnavailableError.make({ message: "Setup is required." })),
          unpause: (loop) => record(`unpause:${loop}`),
          moveBoardItem: (move) => record(`move:${move.repository}#${move.item}:${move.toLane}`),
          task: (repository, item) =>
            repository === repositoryName && item === 31
              ? Effect.succeed(task)
              : Effect.fail(BoardItemNotFoundError.make({ repository, item })),
          configuration: Effect.succeed(configurationView),
          desk: Effect.succeed(desk),
          statistics: (window) => Effect.succeed(statisticsOf(window)),
          runStatistics: (window) => Effect.succeed(runStatisticsOf(window)),
        });
        const server = HttpRouter.serve(apiRoutes.pipe(HttpRouter.provideRequest(live))).pipe(
          Layer.provideMerge(NodeHttpServer.layerTest),
        );
        yield* Effect.gen(function* () {
          const { operator: client } = yield* HttpApiClient.make(OperatorApi);
          const currentOverview = yield* client.overview();
          assert.deepStrictEqual(currentOverview, overview);
          const currentAgents = yield* client.agents();
          assert.deepStrictEqual(currentAgents, [agentName]);
          const currentConfiguration = yield* client.configuration();
          assert.deepStrictEqual(currentConfiguration, configurationView);
          const edit = EditAndRetry.make({
            task: AttemptTask.make("Fix the reviewed behavior"),
            agent: agentName,
          });
          yield* client.editAndRetry({ params: { runId }, payload: edit });
          const runAgainResult = yield* client.runAgain({ params: { runId }, payload: edit });
          assert.deepStrictEqual(runAgainResult, opened);
          assert.deepStrictEqual(againEdits, [edit]);
          const input = SessionIntervention.make({
            attemptId: AttemptId.make("attempt/1"),
            target: ParentTarget.make(),
            action: OperatorMessage.make({ message: "Continue carefully" }),
          });
          yield* client.intervene({ params: { runId }, payload: input });
          assert.deepStrictEqual(edits, [edit]);
          assert.deepStrictEqual(inputs, [input]);
          const requests = [
            ColdTranscriptRequest.make(),
            TailTranscriptRequest.make({ after: TranscriptSequence.make(7) }),
            EarlierTranscriptRequest.make({
              attemptId: AttemptId.make("attempt/1"),
              before: TranscriptSequence.make(4),
            }),
          ];
          for (const query of requests) {
            const runDetail = yield* client.detail({ params: { runId }, query });
            assert.deepStrictEqual(runDetail, detail);
          }
          assert.deepStrictEqual(observed, requests);
          const currentGithubChanges = yield* client.githubChanges({ params: { runId } });
          assert.deepStrictEqual(currentGithubChanges, githubChanges);
          const currentTask = yield* client.task({
            params: { owner: "basaltbytes", repository: "usine", item: ItemNumber.make(31) },
          });
          assert.deepStrictEqual(currentTask, task);
          const currentProject = yield* client.project({
            params: { project: ProjectId.make("workspace") },
          });
          assert.deepStrictEqual(currentProject, overview.projects[0]);
          const nextTask = yield* client.projectTask({
            params: { project: ProjectId.make("workspace"), item: ItemNumber.make(31) },
            query: { repository: repositoryName },
          });
          assert.deepStrictEqual(nextTask, task);
          const unrelatedProject = yield* client
            .projectTask({
              params: { project: ProjectId.make("workspace"), item: ItemNumber.make(31) },
              query: { repository: RepositoryName.make("other/repository") },
            })
            .pipe(Effect.flip);
          assert.instanceOf(unrelatedProject, OperatorHttpError);
          assert.strictEqual(unrelatedProject.error, "BoardProjectNotFoundError");
          for (const action of ["dismissNeed", "undoDismissNeed"] as const) {
            const actionResult = yield* client[action]({
              payload: AttentionKey.make({
                id: "finding",
                revision: AttentionRevision.make("revision"),
              }),
            });
            assert.deepStrictEqual(actionResult, { ok: true });
          }
          const resetResult = yield* client.resetCycleBudget({
            payload: { askId: CycleBudgetAskId.make("current-ask") },
          });
          assert.deepStrictEqual(resetResult.replayedCiFixEventIds, [
            EventId.make("blocked-ci-fix"),
          ]);
          const resolution = yield* client.resolveFailure({
            params: { runId },
            payload: { attemptId: AttemptId.make("attempt/1") },
          });
          assert.deepStrictEqual(resolution, { ok: true });
          const staleResolution = yield* Effect.flip(
            client.resolveFailure({
              params: { runId },
              payload: { attemptId: AttemptId.make("older-attempt") },
            }),
          );
          assert.instanceOf(staleResolution, OperatorHttpError);
          assert.strictEqual(staleResolution.status, 409);
          for (const action of ["approve", "retry", "cancel"] as const) {
            const currentActionResult = yield* client[action]({ params: { runId } });
            assert.deepStrictEqual(currentActionResult, { ok: true });
          }
          for (const action of ["pause", "unpause"] as const) {
            const nextActionResult = yield* client[action]({ params: { loop: loopName } });
            assert.deepStrictEqual(nextActionResult, {
              ok: true,
            });
          }
          const moveResult = yield* client.moveBoardItem({
            params: { owner: "basaltbytes", repository: "usine", item: ItemNumber.make(31) },
            payload: { toLane: BoardLaneId.make("authored:Review") },
          });
          assert.deepStrictEqual(moveResult, { ok: true });
          const kept = yield* Effect.flip(
            client.discardLeftovers({ params: { worker: WorkerName.make("local") } }),
          );
          assert.instanceOf(kept, OperatorHttpError);
          assert.strictEqual(kept.status, 409);
          assert.strictEqual(
            kept.message,
            '2 attempts are still running on worker "local". Discard its leftovers after they end.',
          );
          assert.deepStrictEqual(interventions, [
            "dismiss:finding:revision",
            "undo:finding:revision",
            "reset:current-ask",
            `resolve:${runId}:attempt/1`,
            `approve:${runId}`,
            `retry:${runId}`,
            `cancel:${runId}`,
            `pause:${loopName}`,
            `unpause:${loopName}`,
            "move:basaltbytes/usine#31:authored:Review",
          ]);

          const missingId = RunId.make("missing/run");
          const staleReset = yield* Effect.flip(
            client.resetCycleBudget({ payload: { askId: CycleBudgetAskId.make("stale-ask") } }),
          );
          assert.instanceOf(staleReset, OperatorHttpError);
          assert.strictEqual(staleReset.status, 409);
          assert.strictEqual(staleReset.error, "CycleBudgetResetRejectedError");
          const missing = yield* Effect.flip(
            client.detail({ params: { runId: missingId }, query: ColdTranscriptRequest.make() }),
          );
          assert.instanceOf(missing, OperatorHttpError);
          assert.strictEqual(missing.error, "RunNotFoundError");
          assert.strictEqual(missing.status, 404);
          assert.strictEqual(missing.message, `Run ${missingId} was not found.`);
          const wrongAttempt = yield* Effect.flip(
            client.detail({
              params: { runId },
              query: EarlierTranscriptRequest.make({
                attemptId: AttemptId.make("other-attempt"),
                before: TranscriptSequence.make(4),
              }),
            }),
          );
          assert.instanceOf(wrongAttempt, OperatorHttpError);
          assert.strictEqual(wrongAttempt.error, "TranscriptAttemptNotFoundError");
          assert.strictEqual(wrongAttempt.status, 404);

          const rejected = yield* Effect.flip(client.approve({ params: { runId: missingId } }));
          assert.instanceOf(rejected, OperatorHttpError);
          assert.strictEqual(rejected.error, "RunOperationRejectedError");
          assert.strictEqual(rejected.status, 409);
          const unavailable = yield* Effect.flip(
            client.pause({ params: { loop: LoopName.make("setup-required") } }),
          );
          assert.instanceOf(unavailable, OperatorHttpError);
          assert.strictEqual(unavailable.error, "BackendUnavailableError");
          assert.strictEqual(unavailable.status, 503);
          assert.strictEqual(unavailable.message, "Setup is required.");
        }).pipe(Effect.provide(server));
      }),
  );

  it.live("serves client routes without masking missing API routes or static files", () =>
    Effect.gen(function* () {
      const webRoot = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.makeTempDirectory({
          directory: dirname(join(tmpdir(), "usine-web-")),
          prefix: basename(join(tmpdir(), "usine-web-")),
        }),
      );
      const assets = join(webRoot, "assets");
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.makeDirectory(assets),
      );
      yield* Effect.all(
        [
          Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
            fileSystem.writeFileString(join(webRoot, "index.html"), "<main>usine operator</main>"),
          ),
          Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
            fileSystem.writeFileString(join(assets, "app.css"), ":root { color-scheme: dark; }"),
          ),
        ],
        { concurrency: "unbounded" },
      );
      const web = HttpRouter.toWebHandler(
        Layer.mergeAll(apiRoutes, staticRoutes(webRoot).pipe(Layer.provide(NodePath.layer))).pipe(
          HttpRouter.provideRequest(Layer.mergeAll(backend, NodeHttpPlatform.layer)),
        ),
        { disableLogger: true },
      );
      try {
        const api = yield* Effect.promise(() =>
          web.handler(new Request("http://localhost/api/overview")),
        );
        assert.strictEqual(api.status, 200);

        const shell = yield* Effect.promise(() => web.handler(new Request("http://localhost/")));
        assert.strictEqual(shell.status, 200);
        const actual21 = yield* Effect.promise(() => shell.text());
        assert.strictEqual(actual21, "<main>usine operator</main>");

        const configuration = yield* Effect.promise(() =>
          web.handler(new Request("http://localhost/configuration/loops")),
        );
        assert.strictEqual(configuration.status, 200);
        assert.deepStrictEqual(
          Object.fromEntries(configuration.headers),
          Object.fromEntries(shell.headers),
        );
        const actual22 = yield* Effect.promise(() => configuration.text());
        assert.strictEqual(actual22, "<main>usine operator</main>");

        const project = yield* Effect.promise(() =>
          web.handler(new Request("http://localhost/projects/basaltbytes/usine?run=run-1")),
        );
        assert.strictEqual(project.status, 200);
        const actual23 = yield* Effect.promise(() => project.text());
        assert.strictEqual(actual23, "<main>usine operator</main>");

        const missingApi = yield* Effect.promise(() =>
          web.handler(new Request("http://localhost/api/does-not-exist")),
        );
        assert.strictEqual(missingApi.status, 404);

        const asset = yield* Effect.promise(() =>
          web.handler(new Request("http://localhost/assets/app.css")),
        );
        assert.strictEqual(asset.status, 200);
        const actual24 = yield* Effect.promise(() => asset.text());
        assert.strictEqual(actual24, ":root { color-scheme: dark; }");

        const missing = yield* Effect.promise(() =>
          web.handler(new Request("http://localhost/assets/missing.js")),
        );
        assert.strictEqual(missing.status, 404);

        // Encoded traversal must never escape the assets root.
        const traversal = yield* Effect.promise(() =>
          web.handler(new Request("http://localhost/assets/%2e%2e/index.html")),
        );
        assert.strictEqual(traversal.status, 404);

        const missingFile = yield* Effect.promise(() =>
          web.handler(new Request("http://localhost/favicon.ico")),
        );
        assert.strictEqual(missingFile.status, 404);
      } finally {
        yield* Effect.promise(() => web.dispose());
        yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.remove(webRoot, { recursive: true }),
        );
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
  // Linux routes all of 127.0.0.0/8 to the loopback interface; macOS has only 127.0.0.1.
  it.live.skipIf(process.platform !== "linux")(
    "listens on 127.0.0.1 only and applies security headers to the assembled server",
    () =>
      Effect.gen(function* () {
        const port = yield* Effect.callback<Port>((resume) => {
          const resolve = (value: Port) => resume(Effect.succeed(value));
          const probe = createServer();
          probe.listen({ host: SERVER_HOST, port: 0 }, () => {
            // Node event callbacks decode their arguments synchronously.
            // @effect-diagnostics-next-line schemaSync:off
            const { port: free } = Schema.decodeUnknownSync(Schema.Struct({ port: Port }))(
              probe.address(),
            );
            probe.close(() => resolve(free));
          });
        });
        const webRoot = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.makeTempDirectory({
            directory: dirname(join(tmpdir(), "usine-web-")),
            prefix: basename(join(tmpdir(), "usine-web-")),
          }),
        );
        const overview = (host: string) =>
          webRequest(`http://${host}:${port}/api/overview`).pipe(
            Effect.mapBoth({
              onFailure: (cause) => RequestFailed.make({ cause }),
              onSuccess: (response) => {
                assert.equal(response.headers.get("x-frame-options"), "DENY");
                assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
                return response.status;
              },
            }),
            Effect.orElseSucceed(() => "unreachable"),
          );
        try {
          const statuses = yield* Effect.gen(function* () {
            const fixtureBackend = backend;
            const authentication = yield* authFixture();

            yield* Layer.build(serverLayer(fixtureBackend, webRoot, port, authentication));
            return yield* Effect.all([overview("127.0.0.1"), overview("127.0.0.2")]);
          }).pipe(Effect.scoped);
          assert.deepStrictEqual(statuses, [401, "unreachable"]);
        } finally {
          yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
            fileSystem.remove(webRoot, { recursive: true }),
          );
        }
      }).pipe(Effect.provide(Layer.provideMerge(NodeFileSystem.layer, FetchHttpClient.layer))),
  );
});

it.live(
  "returns a typed server error when statistics cannot read worker configuration history",
  () =>
    Effect.gen(function* () {
      const failing = HttpRouter.toWebHandler(
        apiRoutes.pipe(
          HttpRouter.provideRequest(
            Layer.mock(FactoryBackend)({
              runStatistics: () =>
                Effect.fail(
                  ConfigurationStoreError.make({
                    operation: "read revisions",
                    cause: "private database details",
                  }),
                ),
            }),
          ),
        ),
        { disableLogger: true },
      );
      try {
        const response = yield* Effect.promise(() =>
          failing.handler(new Request("http://localhost/api/statistics/runs")),
        );
        assert.strictEqual(response.status, 500);
        const actual25 = yield* Effect.promise(() => response.json());
        assert.deepStrictEqual(actual25, {
          error: "ConfigurationStoreError",
          message: "Configuration store error: could not read revisions.",
        });
      } finally {
        yield* Effect.promise(() => failing.dispose());
      }
    }),
);

it.live("checks the declared permission for every operator route and each role", () =>
  Effect.gen(function* () {
    const roles = ["viewer", "operator", "maintainer", "admin"] as const;
    for (const role of roles) {
      const binding = RoleBinding.make({
        name: role,
        member: GitHubUserId.make(1),
        role,
        scope:
          role === "admin"
            ? InstanceScope.make()
            : ProjectScope.make({ project: ProjectId.make("alpha") }),
      });
      const secured = HttpRouter.toWebHandler(
        apiRoutes.pipe(
          HttpRouter.provideRequest(
            Layer.merge(backend, Layer.succeed(RequestPermissions, binding.permissions)),
          ),
        ),
        { disableLogger: true },
      );
      try {
        for (const endpoint of Object.values(OperatorApi.groups.operator.endpoints)) {
          const permission = operatorPermissions[endpoint.identifier];
          const allowed =
            permission === "public" ||
            role === "admin" ||
            binding.permissions.some((grant) => grant.permission === permission);
          const path = endpoint.path
            .replace(/:project\b/g, "alpha")
            .replace(/:[A-Za-z]+/g, "sample");
          const request: RequestInit = { method: endpoint.method };
          if (endpoint.method !== "GET") {
            request.body = "{}";
            request.headers = { "content-type": "application/json" };
          }
          const response = yield* Effect.promise(() =>
            secured.handler(new Request(`http://localhost${path}`, request)),
          );
          assert.equal(
            response.status === 403,
            !allowed,
            `${role}: ${endpoint.method} ${endpoint.path} returned ${response.status}`,
          );
        }
      } finally {
        yield* Effect.promise(() => secured.dispose());
      }
    }
  }),
);

it.live("returns a private validator and an empty 304 for unchanged authorized reads", () =>
  Effect.gen(function* () {
    const request = (headers: Record<string, string> = {}) =>
      app.handler(new Request("http://localhost/api/overview", { headers }));
    const first = yield* Effect.promise(() => request());
    assert.strictEqual(first.status, 200);
    const etag = first.headers.get("etag");
    assert(etag !== null);
    assert.strictEqual(first.headers.get("cache-control"), "private, no-cache");
    const second = yield* Effect.promise(() => request({ "if-none-match": `W/${etag}` }));
    assert.strictEqual(second.status, 304);
    const actual26 = yield* Effect.promise(() => second.text());
    assert.strictEqual(actual26, "");
    const shell = yield* Effect.promise(() =>
      request({ "x-usine-view": "shell", "if-none-match": etag }),
    );
    assert.strictEqual(shell.status, 200);
    assert.include(shell.headers.get("vary") ?? "", "x-usine-view");
  }),
);

it.live("retains all linked card membership when the board read omits settled cards", () =>
  Effect.gen(function* () {
    const item = task.items[0];
    const original = overview.projects[0];
    assert(item !== undefined && original !== undefined);
    const member = BoardItemLink.make(item);
    const current = BoardItemLink.make({
      ...member,
      itemKey: ItemKey.make("github:basaltbytes/usine:42"),
      kind: "pr",
      number: ItemNumber.make(42),
      state: "pr-merged",
    });
    const card = BoardTaskView.make({
      ...current,
      repository: repositoryName,
      items: [member, current],
      ...boardRunSummary(
        [
          RunSummaryView.make({
            ...run,
            attempts: run.attempts.map((attempt) => AttemptSummaryView.make(attempt)),
          }),
        ],
        RunSummaryView.make({
          ...run,
          attempts: run.attempts.map((attempt) => AttemptSummaryView.make(attempt)),
        }),
        [member, current],
      ),
      run: RunSummaryView.make({
        ...run,
        attempts: run.attempts.map((attempt) => AttemptSummaryView.make(attempt)),
      }),
      pullRequest: null,
      needsYou: false,
      loops: [],
      usage: TaskUsageView.make({
        durationMillis: 0,
        runningSince: [],
        unmeasured: 0,
        tokens: TokenCount.make(0),
        pools: [],
        cost: null,
      }),
    });
    const project = ProjectView.make({
      ...original,
      board: BoardView.make({
        failures: [],
        lanes: [
          ReadOnlyBoardLaneView.make({
            id: BoardLaneId.make("Done"),
            name: LaneName.make("Done"),
            origin: "authored",
            sources: [StateLaneSource.make({ state: "pr-merged" })],
            items: [card],
          }),
        ],
      }),
    });
    const read = Layer.effect(
      FactoryBackend,
      Effect.map(FactoryBackend, (service) => ({
        ...service,
        overview: Effect.succeed(ReadyOverview.make({ ...overview, projects: [project] })),
      })),
    ).pipe(Layer.provide(backend));
    const boardApp = HttpRouter.toWebHandler(apiRoutes.pipe(HttpRouter.provideRequest(read)), {
      disableLogger: true,
    });
    try {
      const response = yield* Effect.promise(() =>
        boardApp.handler(
          new Request("http://localhost/api/projects/workspace", {
            headers: { "x-usine-view": "board" },
          }),
        ),
      );
      assert.strictEqual(response.status, 200);
      const actual27 = yield* Effect.promise(() => response.json());
      const paged = yield* Schema.decodeUnknownEffect(ProjectView)(actual27);
      assert.deepStrictEqual(paged.board.cardedItemKeys, [member.itemKey, current.itemKey]);
      assert.deepStrictEqual(paged.board.lanes[0]?.items, []);
      assert.strictEqual(paged.board.lanes[0]?.totalItems, 1);
      assert.deepStrictEqual(
        paged.runs.map(({ id }) => id),
        project.runs.map(({ id }) => id),
      );
    } finally {
      yield* Effect.promise(() => boardApp.dispose());
    }
  }),
);

it.live("streams small changes and replays missed revisions without payloads", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(changeBusLayer);
      const bus = Context.get(context, ChangeBus);
      {
        const streamApp = HttpRouter.toWebHandler(
          apiRoutes.pipe(
            Layer.provide(Layer.succeed(ChangeBus, bus)),
            HttpRouter.provideRequest(backend),
          ),
          {
            disableLogger: true,
          },
        );
        const open = (last?: string) =>
          streamApp.handler(
            new Request("http://localhost/api/changes", {
              headers: last === undefined ? {} : { "last-event-id": last },
            }),
          );
        try {
          const response = yield* Effect.promise(() => open());
          assert.strictEqual(response.headers.get("content-type"), "text/event-stream");
          const reader = response.body?.getReader();
          assert(reader !== undefined);
          const first = new TextDecoder().decode(
            (yield* Effect.promise(() => reader.read())).value,
          );
          assert.include(first, ": heartbeat");
          const cursor = /id: (\d+)/u.exec(first)?.[1];
          assert(cursor !== undefined);
          yield* bus.publish([
            { audience: InstanceScope.make(), target: { kind: "project", id: "workspace" } },
          ]);
          const changed = new TextDecoder().decode(
            (yield* Effect.promise(() => reader.read())).value,
          );
          assert.include(changed, '"kind":"project","id":"workspace"');
          assert.notInclude(changed, "Renamed workspace");
          assert.isBelow(changed.length, 1_024);
          yield* Effect.promise(() => reader.cancel());
          const resumed = yield* Effect.promise(() => open(cursor));
          const replayReader = resumed.body?.getReader();
          assert(replayReader !== undefined);
          const replay = new TextDecoder().decode(
            (yield* Effect.promise(() => replayReader.read())).value,
          );
          assert.include(replay, '"reset":false');
          assert.include(replay, '"kind":"project","id":"workspace"');
          yield* Effect.promise(() => replayReader.cancel());
          for (const invalidCursor of ["not-a-revision", "0", String(Number.MAX_SAFE_INTEGER)]) {
            const reset = yield* Effect.promise(() => open(invalidCursor));
            const resetReader = reset.body?.getReader();
            assert(resetReader !== undefined);
            const frame = new TextDecoder().decode(
              (yield* Effect.promise(() => resetReader.read())).value,
            );
            assert.include(frame, '"reset":true');
            yield* Effect.promise(() => resetReader.cancel());
          }
        } finally {
          yield* Effect.promise(() => streamApp.dispose());
        }
      }
    }),
  ),
);

class RequestFailed extends Schema.TaggedError<RequestFailed, { readonly Brand: unique symbol }>()(
  "RequestFailed",
  { cause: Schema.Defect() },
) {}
