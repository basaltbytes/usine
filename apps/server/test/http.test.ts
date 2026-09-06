import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpPlatform, NodeHttpServer } from "@effect/platform-node";
import { LoadedInstance } from "@usine/config/instance";
import { UsineConfig } from "@usine/config/factory";
import { AgentName } from "@usine/core/agent";
import { AttemptId } from "@usine/core/attempt";
import { CycleBudgetAskId } from "@usine/core/cycle-budget";
import { ItemKey, ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { RunNotFoundError, RunOperationRejectedError } from "@usine/engine/engine";
import { CycleBudgetResetRejectedError } from "@usine/engine/cycle-budget";
import { TranscriptSequence } from "@usine/engine/transcript";
import {
  ApprovalNeed,
  BoardLaneId,
  BoardLaneReadOnlyError,
  type BoardMove,
  BoardView,
  ColdTranscriptRequest,
  EarlierTranscriptRequest,
  FactoryOverview,
  FailedTranscriptView,
  InfraFailureView,
  LoopView,
  ProjectView,
  ReadyOverview,
  RunDetailView,
  RunView,
  TranscriptAttemptNotFoundError,
  TranscriptEventView,
  TranscriptPageCursor,
  TailTranscriptRequest,
  type TranscriptRequest,
  OperatorObservation,
} from "@usine/orchestrator/operator";
import { OperatorApi, OperatorHttpError } from "@usine/orchestrator/operator/http";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { afterAll, assert, describe, it } from "vitest";
import { BackendUnavailableError, FactoryBackend, needsSetupBackendLayer } from "../src/backend.ts";
import { apiRoutes, staticRoutes } from "../src/http.ts";

const runId = RunId.make("run-1");
const loopName = LoopName.make("review-issue");
const agentName = AgentName.make("developer");
const repositoryName = RepositoryName.make("basaltbytes/usine");
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
  itemKey: ItemKey.make("issue:31"),
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
  transcript: [
    new TranscriptEventView({
      attemptId: AttemptId.make("attempt/1"),
      sequence: TranscriptSequence.make(7),
      receivedAt: "2026-09-01T12:00:00.000Z",
      direction: "outbound",
      payload: new FailedTranscriptView({
        failure: new InfraFailureView({ message: "Worker disconnected" }),
      }),
    }),
  ],
  earlierTranscript: [
    new TranscriptPageCursor({
      attemptId: AttemptId.make("attempt/1"),
      before: TranscriptSequence.make(7),
    }),
  ],
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

    for (const search of [
      "after=2&after=0",
      "attempt=a&attempt=b&before=2",
      "after=2&unrelated=x",
    ]) {
      const repeated = await app.handler(
        new Request(`http://localhost/api/runs/${runId}?${search}`),
      );
      assert.strictEqual(repeated.status, 200, search);
    }

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

    for (const search of [
      "before=2",
      "attempt=a",
      "after=2&before=3",
      "after=2&attempt=a",
      "after=2&attempt=a&before=3",
    ]) {
      const invalid = await app.handler(
        new Request(`http://localhost/api/runs/${runId}?${search}`),
      );
      assert.strictEqual(invalid.status, 400, search);
      assert.strictEqual((await invalid.json()).error, "SchemaError");
    }
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

    // A loopback origin (the Vite dev server) reaches the handler; the
    // needs-setup 503 proves the guard let it through.
    const loopback = await app.handler(
      new Request(`http://localhost/api/runs/${runId}/approve`, {
        method: "POST",
        headers: { origin: "http://localhost:5173" },
      }),
    );
    assert.strictEqual(loopback.status, 503);

    const malformed = await app.handler(
      new Request("http://localhost/api/projects/a/b/items/0/lane", {
        method: "POST",
        headers: { origin: "null" },
        body: "not JSON",
      }),
    );
    assert.strictEqual(malformed.status, 403);
    assert.strictEqual((await malformed.json()).error, "CrossSiteRequestError");
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
      approve: (id: RunId) =>
        Effect.fail(
          new RunOperationRejectedError({ runId: id, operation: "approve", state: "Running" }),
        ),
      resetCycleBudget: () => Effect.void,
      retry: () => Effect.void,
      cancel: () => Effect.void,
      moveBoardItem: (move) =>
        move.toLane === "proposed:ready"
          ? Effect.fail(
              new BoardLaneReadOnlyError({ repository: move.repository, lane: move.toLane }),
            )
          : Effect.sync(() => void (moved = move)),
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

      const wrongAttempt = AttemptId.make("attempt-from-another-run");
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
      const proposed = await rejectingApp.handler(
        new Request("http://localhost/api/projects/basaltbytes/usine/items/31/lane", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ toLane: "proposed:ready" }),
        }),
      );
      assert.strictEqual(proposed.status, 409);
      const refusal = Schema.decodeUnknownSync(OperatorHttpError)(await proposed.json());
      assert.strictEqual(refusal.error, "BoardLaneReadOnlyError");
      assert.match(refusal.message, /read-only/i);
      assert.match(refusal.message, /usine\.yaml/);

      // Authored fields are strict even though JSON has always been accepted
      // independently of the caller's Content-Type.
      for (const body of ["{", '{"toLane":"authored:Review","typo":true}', '{"toLane":42}']) {
        const invalid = await rejectingApp.handler(
          new Request("http://localhost/api/projects/basaltbytes/usine/items/31/lane", {
            method: "POST",
            body,
          }),
        );
        assert.strictEqual(invalid.status, 400);
        assert.strictEqual((await invalid.json()).error, "InvalidRequestError");
      }
      const simplePost = await rejectingApp.handler(
        new Request("http://localhost/api/projects/basaltbytes/usine/items/31/lane", {
          method: "POST",
          body: '{"toLane":"authored:Done"}',
        }),
      );
      assert.strictEqual(simplePost.status, 200);
      assert.strictEqual(moved?.toLane, "authored:Done");
    } finally {
      await rejectingApp.dispose();
    }
  });

  it("round-trips the derived client through a listening server for reads, interventions, cursors, and typed failures", async () => {
    const observed: Array<TranscriptRequest> = [];
    const interventions: Array<string> = [];
    const record = (operation: string) => Effect.sync(() => void interventions.push(operation));
    const live = Layer.succeed(FactoryBackend)({
      overview: Effect.succeed(overview),
      detail: (id, request) => {
        if (id !== runId) return Effect.fail(new RunNotFoundError({ runId: id }));
        if (request._tag === "EarlierTranscriptRequest" && request.attemptId !== "attempt/1") {
          return Effect.fail(
            new TranscriptAttemptNotFoundError({ runId: id, attemptId: request.attemptId }),
          );
        }
        return Effect.sync(() => {
          observed.push(request);
          return detail;
        });
      },
      approve: (id) =>
        id === runId
          ? record(`approve:${id}`)
          : Effect.fail(
              new RunOperationRejectedError({ runId: id, operation: "approve", state: "Running" }),
            ),
      resetCycleBudget: (id) =>
        id === "current-ask"
          ? record(`reset:${id}`)
          : Effect.fail(new CycleBudgetResetRejectedError({ askId: id })),
      retry: (id) => record(`retry:${id}`),
      cancel: (id) => record(`cancel:${id}`),
      pause: (loop) =>
        loop === loopName
          ? record(`pause:${loop}`)
          : Effect.fail(new BackendUnavailableError({ message: "Setup is required." })),
      unpause: (loop) => record(`unpause:${loop}`),
      moveBoardItem: (move) => record(`move:${move.repository}#${move.item}:${move.toLane}`),
    });
    const server = HttpRouter.serve(apiRoutes.pipe(HttpRouter.provideRequest(live))).pipe(
      Layer.provideMerge(NodeHttpServer.layerTest),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const { operator: client } = yield* HttpApiClient.make(OperatorApi);
        assert.deepStrictEqual(yield* client.overview(), overview);
        const requests = [
          new ColdTranscriptRequest(),
          new TailTranscriptRequest({ after: TranscriptSequence.make(7) }),
          new EarlierTranscriptRequest({
            attemptId: AttemptId.make("attempt/1"),
            before: TranscriptSequence.make(4),
          }),
        ];
        for (const query of requests) {
          assert.deepStrictEqual(yield* client.detail({ params: { runId }, query }), detail);
        }
        assert.deepStrictEqual(observed, requests);
        assert.deepStrictEqual(
          yield* client.resetCycleBudget({
            payload: { askId: CycleBudgetAskId.make("current-ask") },
          }),
          { ok: true },
        );
        for (const action of ["approve", "retry", "cancel"] as const) {
          assert.deepStrictEqual(yield* client[action]({ params: { runId } }), { ok: true });
        }
        for (const action of ["pause", "unpause"] as const) {
          assert.deepStrictEqual(yield* client[action]({ params: { loop: loopName } }), {
            ok: true,
          });
        }
        assert.deepStrictEqual(
          yield* client.moveBoardItem({
            params: { owner: "basaltbytes", repository: "usine", item: ItemNumber.make(31) },
            payload: { toLane: BoardLaneId.make("authored:Review") },
          }),
          { ok: true },
        );
        assert.deepStrictEqual(interventions, [
          "reset:current-ask",
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
          client.detail({ params: { runId: missingId }, query: new ColdTranscriptRequest() }),
        );
        assert.instanceOf(missing, OperatorHttpError);
        assert.strictEqual(missing.error, "RunNotFoundError");
        assert.strictEqual(missing.status, 404);
        assert.strictEqual(missing.message, `Run ${missingId} was not found.`);
        const wrongAttempt = yield* Effect.flip(
          client.detail({
            params: { runId },
            query: new EarlierTranscriptRequest({
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
      }).pipe(Effect.provide(server)),
    );
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
