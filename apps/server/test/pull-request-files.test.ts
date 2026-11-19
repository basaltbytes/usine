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
  CommitRangeFilesQuery,
  FileChanges,
  FileChangesQuery,
  PullRequestFilesQuery,
} from "@usine/github/file-changes";
import { GitHubFiles } from "@usine/github/files";
import {
  CoveredProject,
  InstallationId,
  InstallationToken,
  InstallationWide,
  ProjectNotInstalledError,
  RepositoryId,
} from "@usine/github/github-app";
import { ConfigurationView, PAGE_BYTES, SettingsView } from "@usine/orchestrator/operator";
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
    maxBackgroundWaitMinutes: null,
    parentModel: null,
    parentEffort: null,
    coordinator: "session",
    supervisor: null,
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
  const access = { checks: 0, installed: true };
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
        projectAccess: (registry) =>
          Effect.sync(() => {
            access.checks += 1;
            return registry.map((repository) =>
              access.installed
                ? CoveredProject.make({
                    installationId: InstallationId.make(77),
                    repository,
                    repositoryId: RepositoryId.make(99),
                  })
                : ProjectNotInstalledError.make({
                    repository,
                    message: `The GitHub App installation has no access to "${repository}"`,
                  }),
            );
          }),
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
  // Reads the full representation, as the web UI does, or the page from `offset` when given.
  const read = Effect.fn(function* (
    query: FileChangesQuery,
    repo = repository,
    projectId = project,
    offset?: number,
  ) {
    const encoded = yield* Schema.encodeEffect(FileChangesQuery)(query);
    const search = new URLSearchParams(encoded);
    if (offset !== undefined) search.set("offset", String(offset));
    return yield* Effect.promise(() =>
      app.handler(
        new Request(
          `http://localhost/api/projects/${projectId}/pull-requests/${encodeURIComponent(repo)}/42/files?${search}`,
          { headers: offset === undefined ? { "x-usine-view": "full" } : {} },
        ),
      ),
    );
  });
  return { ...app, requests, access, read };
});

const decode = Effect.fn(function* (response: Response) {
  const body = yield* Effect.promise(() => response.json());
  return yield* Schema.decodeUnknownEffect(FileChanges)(body);
});

it.live("pages the files to fit one tool result and cuts a patch too long for a page", () =>
  Effect.gen(function* () {
    const longPatch = `@@ -1 +1,4000 @@\n${"+const changed = true;\n".repeat(4_000)}`;
    const app = yield* fixture((url) =>
      url.pathname.endsWith("/files")
        ? json(
            Array.from({ length: 60 }, (_, index) =>
              index === 0
                ? { ...file, filename: "pnpm-lock.yaml", additions: 4_000, patch: longPatch }
                : { ...file, filename: `src/${index}.ts` },
            ),
          )
        : json({ ...pr, changed_files: 60 }),
    );
    const query = PullRequestFilesQuery.make({ base, head });
    const full = yield* app.read(query).pipe(Effect.flatMap(decode));
    assert.lengthOf(full.files, 60);
    assert.isUndefined(full.nextOffset);
    const paths: Array<string> = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const response: Response = yield* app.read(query, repository, project, offset);
      const text = yield* Effect.promise(() => response.text());
      assert.isAtMost(new TextEncoder().encode(text).length, PAGE_BYTES);
      const page = yield* Schema.decodeEffect(Schema.fromJsonString(FileChanges))(text);
      assert.strictEqual(page.total, 60);
      if (offset === 0) {
        assert.lengthOf(page.files, 1);
        const [lockfile] = page.files;
        assert(lockfile?.patch.kind === "text");
        assert.isTrue(lockfile.patch.truncated);
        assert.isTrue(longPatch.startsWith(lockfile.patch.text));
      }
      paths.push(...page.files.map(({ path }) => path));
      offset = page.nextOffset ?? null;
    }
    assert.deepStrictEqual(
      paths,
      full.files.map(({ path }) => path),
    );
  }).pipe(Effect.scoped),
);

it.live(
  "loads a retargeted PR with the same head under its new base and rejects stale selections",
  () =>
    Effect.gen(function* () {
      let target = base;
      const app = yield* fixture((url) =>
        url.pathname.endsWith("/files")
          ? json([{ ...file, filename: target === base ? "old-target.ts" : "new-target.ts" }])
          : json({ ...pr, base: { sha: target } }),
      );
      const old = yield* app
        .read(PullRequestFilesQuery.make({ base, head }))
        .pipe(Effect.flatMap(decode));
      assert.strictEqual(old.files[0]?.path, "old-target.ts");
      target = first;
      const current = yield* app
        .read(PullRequestFilesQuery.make({ base: target, head }))
        .pipe(Effect.flatMap(decode));
      assert.strictEqual(current.files[0]?.path, "new-target.ts");
      assert.strictEqual(current.base, target);
      assert.strictEqual(app.requests.length, 6);
      yield* app.read(PullRequestFilesQuery.make({ base: target, head }));
      assert.strictEqual(app.requests.length, 6);

      const stale = yield* fixture((url) =>
        url.pathname.endsWith("/files") ? json([file]) : json({ ...pr, base: { sha: target } }),
      );
      assert.strictEqual(
        (yield* stale.read(PullRequestFilesQuery.make({ base, head }))).status,
        409,
      );
      assert.strictEqual(
        (yield* stale.read(PullRequestFilesQuery.make({ base: target, head }))).status,
        200,
      );
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
    const query = PullRequestFilesQuery.make({ base, head });
    const failed = yield* app.read(query);
    assert.strictEqual(failed.status, 409);
    const body = yield* Effect.promise(() => failed.json());
    assert.ok(
      Schema.is(Schema.Struct({ error: Schema.Literal("PullRequestFilesChangedError") }))(body),
    );
    const retried = yield* app.read(query);
    assert.strictEqual(retried.status, 200);
    assert.strictEqual(snapshots, 4);
    assert.strictEqual(app.requests.length, 6);
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
    const query = PullRequestFilesQuery.make({ base, head });
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
          `http://localhost/api/projects/workspace/pull-requests/${encodeURIComponent(repository)}/42/files?scope=PullRequestFiles&head=main`,
        ),
      ),
    );
    assert.strictEqual(invalid.status, 400);
    assert.strictEqual(app.requests.length, requests);
  }).pipe(Effect.scoped),
);

it.live("maps GitHub 422 to a missing file selection and retries on the next read", () =>
  Effect.gen(function* () {
    const status = 422;
    let unavailable = true;
    const app = yield* fixture((url) =>
      unavailable
        ? new Response("{}", { status })
        : url.pathname.includes("/compare/")
          ? json({ files: [file] })
          : url.pathname.endsWith("/files")
            ? json([file])
            : json(pr),
    );
    for (const query of [
      PullRequestFilesQuery.make({ base, head }),
      CommitRangeFilesQuery.make({ base, head }),
    ]) {
      unavailable = true;
      const response = yield* app.read(query);
      assert.strictEqual(response.status, 404);
      const body = yield* Effect.promise(() => response.json());
      const error = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          error: Schema.Literal("FileChangesNotFoundError"),
          message: Schema.String,
        }),
      )(body);
      assert.match(error.message, /commits?|comparison/u);
      unavailable = false;
      assert.strictEqual((yield* app.read(query)).status, 200);
    }
    assert.strictEqual(app.access.checks, 0);
  }).pipe(Effect.scoped),
);

it.live("reports lost App access instead of a missing comparison when GitHub answers 404", () =>
  Effect.gen(function* () {
    const app = yield* fixture(() => new Response("{}", { status: 404 }));
    app.access.installed = false;
    for (const query of [
      PullRequestFilesQuery.make({ base, head }),
      CommitRangeFilesQuery.make({ base, head }),
    ]) {
      const response = yield* app.read(query);
      assert.strictEqual(response.status, 503);
      const body = yield* Effect.promise(() => response.json());
      const error = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          error: Schema.Literal("ProjectNotInstalledError"),
          message: Schema.String,
        }),
      )(body);
      assert.match(error.message, /lost access to basaltbytes\/usine/u);
    }
    assert.strictEqual(app.access.checks, 2);
  }).pipe(Effect.scoped),
);

it.live("preserves GitHub rate-limit errors instead of reporting a missing comparison", () =>
  Effect.gen(function* () {
    const app = yield* fixture(
      () =>
        new Response("{}", {
          status: 429,
          headers: { "retry-after": "60" },
        }),
    );
    const response = yield* app.read(CommitRangeFilesQuery.make({ base, head }));
    assert.strictEqual(response.status, 503);
    const body = yield* Effect.promise(() => response.json());
    assert.ok(Schema.is(Schema.Struct({ error: Schema.Literal("GitHubRateLimitError") }))(body));
    assert.strictEqual(app.requests.length, 1);
  }).pipe(Effect.scoped),
);

it.live(
  "retains a diff larger than 512 KiB and shares one GitHub read between concurrent requests",
  () =>
    Effect.gen(function* () {
      const app = yield* fixture(() =>
        json({ files: [{ ...file, patch: "+" + "é".repeat(300_000) }] }),
      );
      const query = CommitRangeFilesQuery.make({ base, head });
      const [first, second] = yield* Effect.all(
        [
          app.read(query).pipe(Effect.flatMap(decode)),
          app.read(query).pipe(Effect.flatMap(decode)),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepStrictEqual(second, first);
      assert.strictEqual(first.files.length, 1);
      assert.strictEqual(app.requests.length, 1);
      const again = yield* app.read(query).pipe(Effect.flatMap(decode));
      assert.deepStrictEqual(again, first);
      assert.strictEqual(app.requests.length, 1);
    }).pipe(Effect.scoped),
);
