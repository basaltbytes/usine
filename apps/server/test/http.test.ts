import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpPlatform } from "@effect/platform-node";
import { LoadedInstance, UsineConfig } from "@usine/config";
import { Agent, Attempt, Item, Loop, Repository, Run } from "@usine/core";
import { RunNotFoundError, RunOperationRejectedError } from "@usine/engine";
import {
  ApprovalNeed,
  BoardLaneId,
  type BoardMove,
  BoardView,
  FactoryOverview,
  LoopView,
  OperatorObservation,
  ProjectView,
  ReadyOverview,
  RunDetailView,
  RunView,
  TranscriptAttemptNotFoundError,
} from "@usine/orchestrator";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { afterAll, assert, describe, it } from "vitest";
import { FactoryBackend, needsSetupBackendLayer } from "../src/backend.ts";
import { apiRoutes, staticRoutes } from "../src/http.ts";

const runId = Run.RunId.make("run-1");
const loopName = Loop.LoopName.make("review-issue");
const agentName = Agent.Name.make("developer");
const repositoryName = Repository.Name.make("basaltbytes/usine");
const config = Schema.decodeUnknownSync(UsineConfig)({
  version: 1,
  repos: [{ name: "basaltbytes/usine" }],
});
const instance = new LoadedInstance({
  config,
  agents: [],
  invalidAgents: [],
  loops: [],
  quarantinedLoops: [],
  warnings: [],
});
const run = new RunView({
  id: runId,
  itemKey: Item.ItemKey.make("issue:31"),
  loop: loopName,
  repository: repositoryName,
  agent: agentName,
  state: "Waiting",
  loopPaused: true,
  openedAt: "2026-09-01T12:00:00.000Z",
  task: "Review issue 31.",
  attempts: [],
  resultMessage: null,
  pullRequestUrl: null,
  canApprove: true,
  canRetry: false,
  canCancel: false,
});
const detail = new RunDetailView({
  run,
  eventDedupKey: "issue:31",
  eventPayload: { number: 31 },
  transcript: [],
  earlierTranscript: [],
});
const overview = new ReadyOverview({
  projects: [
    new ProjectView({
      repository: repositoryName,
      status: "needs-you",
      runs: [run],
      board: new BoardView({ failures: [], lanes: [] }),
      labels: [],
      preflightFindings: [],
    }),
  ],
  loops: [new LoopView({ name: loopName, trigger: "issue", agent: agentName, paused: true })],
  needsYou: [
    new ApprovalNeed({
      id: `approval:${runId}`,
      repository: repositoryName,
      runId,
      loop: loopName,
    }),
  ],
});
const observation: OperatorObservation["Service"] = {
  overview: () => Effect.succeed(overview),
  detail: () => Effect.succeed(detail),
};
const backend = needsSetupBackendLayer(instance, "SecretsFileError", observation);
const app = HttpRouter.toWebHandler(apiRoutes.pipe(HttpRouter.provideRequest(backend)), {
  disableLogger: true,
});

afterAll(() => app.dispose());

describe("operator HTTP API", () => {
  it("preserves durable observation in needs-setup mode while intervention remains unavailable", async () => {
    const response = await app.handler(new Request("http://localhost/api/overview"));
    assert.strictEqual(response.status, 200);
    const body = Schema.decodeUnknownSync(FactoryOverview)(await response.json());
    assert.strictEqual(body._tag, "NeedsSetup");
    assert.strictEqual(body.projects[0]?.runs[0]?.id, runId);
    assert.strictEqual(body.loops[0]?.paused, true);

    const runResponse = await app.handler(new Request(`http://localhost/api/runs/${runId}`));
    assert.strictEqual(runResponse.status, 200);
    assert.strictEqual((await runResponse.json()).eventDedupKey, "issue:31");

    const action = await app.handler(
      new Request(`http://localhost/api/runs/${runId}/approve`, { method: "POST" }),
    );
    assert.strictEqual(action.status, 503);
    assert.deepStrictEqual(await action.json(), {
      error: "BackendUnavailableError",
      message: "GitHub App setup is required before operator actions are available.",
    });

    const invalidCursor = await app.handler(
      new Request(`http://localhost/api/runs/${runId}?after=0`),
    );
    assert.strictEqual(invalidCursor.status, 400);
    assert.strictEqual((await invalidCursor.json()).error, "SchemaError");

    const incompleteEarlierPage = await app.handler(
      new Request(`http://localhost/api/runs/${runId}?before=2`),
    );
    assert.strictEqual(incompleteEarlierPage.status, 400);
  });

  it("refuses cross-site requests before their side effect while loopback origins pass", async () => {
    const crossSite = await app.handler(
      new Request(`http://localhost/api/runs/${runId}/approve`, {
        method: "POST",
        headers: { origin: "https://evil.example" },
      }),
    );
    assert.strictEqual(crossSite.status, 403);
    assert.strictEqual((await crossSite.json()).error, "CrossSiteRequestError");

    // A loopback origin (the Vite dev server) reaches the handler — here the
    // needs-setup 503, proving the guard let it through.
    const loopback = await app.handler(
      new Request(`http://localhost/api/runs/${runId}/approve`, {
        method: "POST",
        headers: { origin: "http://localhost:5173" },
      }),
    );
    assert.strictEqual(loopback.status, 503);
  });

  it("maps typed engine errors onto operator-readable statuses", async () => {
    let moved: BoardMove | undefined;
    const rejecting = Layer.succeed(FactoryBackend)({
      overview: Effect.succeed(overview),
      detail: (id, request) =>
        request._tag === "EarlierTranscriptRequest"
          ? Effect.fail(
              new TranscriptAttemptNotFoundError({ runId: id, attemptId: request.attemptId }),
            )
          : Effect.fail(new RunNotFoundError({ runId: id })),
      approve: (id: Run.RunId) =>
        Effect.fail(
          new RunOperationRejectedError({ runId: id, operation: "approve", state: "Running" }),
        ),
      retry: () => Effect.void,
      cancel: () => Effect.void,
      moveBoardItem: (move) => Effect.sync(() => void (moved = move)),
      pause: () => Effect.void,
      unpause: () => Effect.void,
    });
    const rejectingApp = HttpRouter.toWebHandler(
      apiRoutes.pipe(HttpRouter.provideRequest(rejecting)),
      { disableLogger: true },
    );
    try {
      const missing = await rejectingApp.handler(new Request("http://localhost/api/runs/run-2"));
      assert.strictEqual(missing.status, 404);
      assert.deepStrictEqual(await missing.json(), {
        error: "RunNotFoundError",
        message: "Run run-2 was not found.",
      });

      const rejected = await rejectingApp.handler(
        new Request(`http://localhost/api/runs/${runId}/approve`, { method: "POST" }),
      );
      assert.strictEqual(rejected.status, 409);
      assert.deepStrictEqual(await rejected.json(), {
        error: "RunOperationRejectedError",
        message: `Cannot approve Run ${runId} while it is Running.`,
      });

      const wrongAttempt = Attempt.AttemptId.make("attempt-from-another-run");
      const earlier = await rejectingApp.handler(
        new Request(`http://localhost/api/runs/${runId}?attempt=${wrongAttempt}&before=2`),
      );
      assert.strictEqual(earlier.status, 404);
      assert.deepStrictEqual(await earlier.json(), {
        error: "TranscriptAttemptNotFoundError",
        message: `Attempt ${wrongAttempt} does not belong to Run ${runId}.`,
      });

      const move = await rejectingApp.handler(
        new Request("http://localhost/api/projects/basaltbytes/usine/items/31/lane", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ toLane: BoardLaneId.make("authored:Review") }),
        }),
      );
      assert.strictEqual(move.status, 200);
      assert.strictEqual(moved?.repository, repositoryName);
      assert.strictEqual(moved?.item, 31);
      assert.strictEqual(moved?.toLane, "authored:Review");
    } finally {
      await rejectingApp.dispose();
    }
  });

  it("serves client routes without masking missing API routes or static files", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "usine-web-"));
    const assets = join(webRoot, "assets");
    await mkdir(assets);
    await Promise.all([
      writeFile(join(webRoot, "index.html"), "<main>usine operator</main>"),
      writeFile(join(assets, "app.css"), ":root { color-scheme: dark; }"),
    ]);
    const web = HttpRouter.toWebHandler(
      Layer.mergeAll(apiRoutes, staticRoutes(webRoot)).pipe(
        HttpRouter.provideRequest(Layer.mergeAll(backend, NodeHttpPlatform.layer)),
      ),
      { disableLogger: true },
    );
    try {
      const api = await web.handler(new Request("http://localhost/api/overview"));
      assert.strictEqual(api.status, 200);

      const shell = await web.handler(new Request("http://localhost/"));
      assert.strictEqual(shell.status, 200);
      assert.strictEqual(await shell.text(), "<main>usine operator</main>");

      const configuration = await web.handler(new Request("http://localhost/configuration/loops"));
      assert.strictEqual(configuration.status, 200);
      assert.deepStrictEqual(
        Object.fromEntries(configuration.headers),
        Object.fromEntries(shell.headers),
      );
      assert.strictEqual(await configuration.text(), "<main>usine operator</main>");

      const project = await web.handler(
        new Request("http://localhost/projects/basaltbytes/usine?run=run-1"),
      );
      assert.strictEqual(project.status, 200);
      assert.strictEqual(await project.text(), "<main>usine operator</main>");

      const missingApi = await web.handler(new Request("http://localhost/api/does-not-exist"));
      assert.strictEqual(missingApi.status, 404);

      const asset = await web.handler(new Request("http://localhost/assets/app.css"));
      assert.strictEqual(asset.status, 200);
      assert.strictEqual(await asset.text(), ":root { color-scheme: dark; }");

      const missing = await web.handler(new Request("http://localhost/assets/missing.js"));
      assert.strictEqual(missing.status, 404);

      // Encoded traversal must never escape the assets root.
      const traversal = await web.handler(new Request("http://localhost/assets/%2e%2e/index.html"));
      assert.strictEqual(traversal.status, 404);

      const missingFile = await web.handler(new Request("http://localhost/favicon.ico"));
      assert.strictEqual(missingFile.status, 404);
    } finally {
      await web.dispose();
      await rm(webRoot, { recursive: true });
    }
  });
});
