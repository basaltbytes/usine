import { operatorOpenApi } from "../src/openapi.ts";
import { jsonKey } from "@usine/core/json-key";
import { assert, it } from "@effect/vitest";
import { Project } from "@usine/config/project";
import {
  administratorPermissions,
  PermissionGrant,
  ProjectScope,
  RequestPermissions,
} from "@usine/core/access";
import { ProjectId } from "@usine/core/project";
import { CommitSha, RepositoryName } from "@usine/core/repository";
import { GitHubApp } from "@usine/github/github-app";
import {
  AttemptFilesQuery,
  CommitRangeFilesQuery,
  FileChanges,
  FileChangesQuery,
  GitHubFiles,
  PullRequestFilesQuery,
} from "@usine/github/files";
import { InstallationToken, InstallationWide } from "@usine/github/github-app";
import { ConfigurationView, SettingsView } from "@usine/orchestrator/operator";
import { DateTime, Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/http";
import { FactoryBackend } from "../src/backend.ts";
import { apiRoutes } from "../src/http.ts";

const repository = RepositoryName.make("basaltbytes/usine");
const project = ProjectId.make("workspace");
const head = CommitSha.make("a".repeat(40));
const base = CommitSha.make("b".repeat(40));
const first = CommitSha.make("c".repeat(40));
const pr = { head: { sha: head }, base: { sha: base }, changed_files: 1 };
const file = {
  filename: "src/reader.ts",
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -1 +1 @@\n-before\n+after",
};
const configuration = ConfigurationView.make({
  projects: [Project.make({ id: project, name: "Workspace", repositories: [repository] })],
  labels: [],
  loops: [],
  quarantinedLoops: [],
  agents: [],
  invalidAgents: [],
  workers: [],
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
const json = (body: Schema.Json) =>
  new Response(jsonKey(body), { headers: { "content-type": "application/json" } });
const fixture = Effect.fn(function* (
  respond: (url: URL) => Response,
  permissions: ReadonlyArray<PermissionGrant> = administratorPermissions,
) {
  const requests: Array<string> = [];
  const github = GitHubFiles.layer.pipe(
    Layer.provide(
      Layer.mock(GitHubApp)({
        installationToken: Effect.succeed(
          InstallationToken.make({
            value: Redacted.make("files-token"),
            expiresAt: DateTime.makeUnsafe("2026-12-01T00:00:00Z"),
            scope: InstallationWide.make(),
          }),
        ),
      }),
    ),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            assert.strictEqual(request.headers.authorization, "Bearer files-token");
            requests.push(request.url);
            return HttpClientResponse.fromWeb(request, respond(new URL(request.url)));
          }),
        ),
      ),
    ),
  );
  const app = HttpRouter.toWebHandler(
    apiRoutes.pipe(
      HttpRouter.provideRequest(
        Layer.mergeAll(
          github,
          Layer.mock(FactoryBackend)({ configuration: Effect.succeed(configuration) }),
          Layer.succeed(RequestPermissions, permissions),
        ),
      ),
    ),
    { disableLogger: true },
  );
  yield* Effect.addFinalizer(() => Effect.promise(() => app.dispose()));
  const read = Effect.fn(function* (
    query: FileChangesQuery,
    repo = repository,
    projectId = project,
  ) {
    const encoded = yield* Schema.encodeEffect(FileChangesQuery)(query);
    const search = new URLSearchParams(encoded);
    return yield* Effect.promise(() =>
      app.handler(
        new Request(
          `http://localhost/api/projects/${projectId}/pull-requests/${encodeURIComponent(repo)}/42/files?${search}`,
        ),
      ),
    );
  });
  return { ...app, requests, read };
});

const decode = Effect.fn(function* (response: Response) {
  const body = yield* Effect.promise(() => response.json());
  return yield* Schema.decodeUnknownEffect(FileChanges)(body);
});

it.live(
  "paginates PR files, preserves renames and missing patches, and reuses the pinned response",
  () =>
    Effect.gen(function* () {
      const app = yield* fixture((url) => {
        if (!url.pathname.endsWith("/files")) return json({ ...pr, changed_files: 101 });
        if (url.searchParams.get("page") === "2")
          return json([
            { ...file, filename: "src/new.ts", previous_filename: "src/old.ts", status: "renamed" },
          ]);
        return json(
          Array.from({ length: 100 }, (_, index) =>
            index === 0
              ? { filename: "test/image.png", status: "added", additions: 0, deletions: 0 }
              : { ...file, filename: `src/${index}.ts` },
          ),
        );
      });
      const response = yield* app.read(PullRequestFilesQuery.make({ head }));
      assert.strictEqual(response.status, 200);
      const changes = yield* decode(response);
      assert.strictEqual(changes.files.length, 101);
      assert.strictEqual(changes.filesTruncated, false);
      assert.strictEqual(changes.files[0]?.patch.kind, "omitted");
      assert.strictEqual(changes.files[0]?.test, true);
      assert.strictEqual(changes.files[100]?.oldPath, "src/old.ts");
      assert.strictEqual(changes.files[100]?.status, "renamed");
      assert.strictEqual(app.requests.length, 4);
      const again = yield* app.read(PullRequestFilesQuery.make({ head }));
      assert.strictEqual(again.status, 200);
      assert.strictEqual(app.requests.length, 4);
    }).pipe(Effect.scoped),
);

it.live("returns an explicit range with truncated patches and test and generated marks", () =>
  Effect.gen(function* () {
    const app = yield* fixture((url) => {
      assert.strictEqual(url.pathname, `/repos/${repository}/compare/${base}...${head}`);
      return json({
        files: [
          { ...file, filename: "src/reader.test.ts", additions: 2 },
          { ...file, filename: "pnpm-lock.yaml" },
        ],
      });
    });
    const changes = yield* app
      .read(CommitRangeFilesQuery.make({ base, head }))
      .pipe(Effect.flatMap(decode));
    assert.strictEqual(changes.base, base);
    assert.strictEqual(changes.files[0]?.test, true);
    assert.deepStrictEqual(changes.files[0]?.patch, {
      kind: "text",
      text: file.patch,
      truncated: true,
    });
    assert.strictEqual(changes.files[1]?.generated, true);
    assert.strictEqual(changes.filesTruncated, false);
  }).pipe(Effect.scoped),
);

it.live("compares an attempt from the first recorded commit's parent and caches the result", () =>
  Effect.gen(function* () {
    const app = yield* fixture((url) =>
      url.pathname.endsWith(`/commits/${first}`)
        ? json({ parents: [{ sha: base }] })
        : json({ files: [file] }),
    );
    const query = AttemptFilesQuery.make({ first, head });
    const changes = yield* app.read(query).pipe(Effect.flatMap(decode));
    assert.strictEqual(changes.base, base);
    assert.strictEqual(app.requests.length, 2);
    assert.ok(app.requests[1]?.includes(`/compare/${base}...${head}`));
    yield* app.read(AttemptFilesQuery.make({ first, head }));
    assert.strictEqual(app.requests.length, 2);
  }).pipe(Effect.scoped),
);

it.live("does not cache files under a head that changed during pagination", () =>
  Effect.gen(function* () {
    let snapshots = 0;
    const app = yield* fixture((url) => {
      if (url.pathname.endsWith("/files")) return json([file]);
      snapshots += 1;
      return json(snapshots === 2 ? { ...pr, head: { sha: first } } : pr);
    });
    const query = PullRequestFilesQuery.make({ head });
    const failed = yield* app.read(query);
    assert.strictEqual(failed.status, 502);
    const body = yield* Effect.promise(() => failed.json());
    assert.ok(
      Schema.is(Schema.Struct({ error: Schema.Literal("InvalidGitHubResponseError") }))(body),
    );
    const retried = yield* app.read(query);
    assert.strictEqual(retried.status, 200);
    assert.strictEqual(snapshots, 4);
    assert.strictEqual(app.requests.length, 6);
  }).pipe(Effect.scoped),
);

it.live("marks GitHub's comparison file limit and PR file limit", () =>
  Effect.gen(function* () {
    const app = yield* fixture((url) =>
      url.pathname.includes("/compare/")
        ? json({
            files: Array.from({ length: 300 }, (_, index) => ({
              ...file,
              filename: `src/${index}.ts`,
            })),
          })
        : url.pathname.endsWith("/files")
          ? json([file])
          : json({ ...pr, changed_files: 3001 }),
    );
    for (const query of [
      CommitRangeFilesQuery.make({ base, head }),
      PullRequestFilesQuery.make({ head }),
    ]) {
      const changes = yield* app.read(query).pipe(Effect.flatMap(decode));
      assert.strictEqual(changes.filesTruncated, true);
    }
  }).pipe(Effect.scoped),
);

it.live("checks the target project and repository before reading GitHub or a cached diff", () =>
  Effect.gen(function* () {
    const permissions = [
      PermissionGrant.make({ permission: "read", scope: ProjectScope.make({ project }) }),
    ];
    const app = yield* fixture(
      (url) => (url.pathname.endsWith("/files") ? json([file]) : json(pr)),
      permissions,
    );
    const query = PullRequestFilesQuery.make({ head });
    const allowed = yield* app.read(query);
    assert.strictEqual(allowed.status, 200);
    const requests = app.requests.length;
    const forbidden = yield* app.read(query, repository, ProjectId.make("private"));
    assert.strictEqual(forbidden.status, 403);
    const unrelated = yield* app.read(query, RepositoryName.make("elsewhere/private"));
    assert.strictEqual(unrelated.status, 404);
    assert.strictEqual(app.requests.length, requests);
    const invalid = yield* Effect.promise(() =>
      app.handler(
        new Request(
          `http://localhost/api/projects/workspace/pull-requests/${encodeURIComponent(repository)}/42/files?_tag=PullRequestFiles&head=main`,
        ),
      ),
    );
    assert.strictEqual(invalid.status, 400);
    assert.strictEqual(app.requests.length, requests);
  }).pipe(Effect.scoped),
);

it("documents every union query parameter and the full commit constraint", () => {
  const parameters =
    operatorOpenApi().paths["/api/projects/{project}/pull-requests/{repository}/{item}/files"]?.get
      ?.parameters ?? [];
  assert.deepStrictEqual(
    parameters
      .filter(({ in: location }) => location === "query")
      .map(({ name, required }) => ({ name, required })),
    [
      { name: "_tag", required: true },
      { name: "head", required: true },
      { name: "base", required: false },
      { name: "first", required: false },
    ],
  );
  assert.deepStrictEqual(
    parameters.find(({ name }) => name === "head")?.schema,
    Schema.toJsonSchemaDocument(CommitSha).schema,
  );
});
