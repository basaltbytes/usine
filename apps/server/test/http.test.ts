import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpPlatform } from "@effect/platform-node";
import { LoadedInstance, UsineConfig } from "@usine/config";
import { Run } from "@usine/core";
import {
  FactoryOverview,
  LoopView,
  NeedView,
  OperatorObservation,
  ProjectView,
  ReadyOverview,
  RunDetailView,
  RunView,
} from "@usine/orchestrator";
import { Effect, Schema } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { afterAll, assert, describe, it } from "vitest";
import { needsSetupBackendLayer } from "../src/backend.ts";
import { apiRoutes, staticRoutes } from "../src/http.ts";

const runId = Run.RunId.make("run-1");
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
});
const run = new RunView({
  id: runId,
  loop: "review-issue",
  repository: "basaltbytes/usine",
  agent: "developer",
  state: "Waiting",
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
});
const overview = new ReadyOverview({
  projects: [
    new ProjectView({ repository: "basaltbytes/usine", status: "needs-you", runs: [run] }),
  ],
  loops: [
    new LoopView({ name: "review-issue", trigger: "issue", agent: "developer", paused: true }),
  ],
  needsYou: [
    new NeedView({
      id: `approval:${runId}`,
      kind: "approval",
      title: "Approval required",
      detail: "review-issue is waiting to run on basaltbytes/usine.",
      repository: "basaltbytes/usine",
      runId,
      loop: "review-issue",
    }),
  ],
});
const observation: OperatorObservation["Service"] = {
  overview: () => Effect.succeed(overview),
  detail: () => Effect.succeed(detail),
};
const backend = needsSetupBackendLayer(
  instance,
  "SecretsFileError",
  "Add GitHub App credentials.",
  observation,
);
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
  });

  it("serves the packaged application shell and assets", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "usine-web-"));
    const assets = join(webRoot, "assets");
    await mkdir(assets);
    await Promise.all([
      writeFile(join(webRoot, "index.html"), "<main>usine operator</main>"),
      writeFile(join(assets, "app.css"), ":root { color-scheme: dark; }"),
    ]);
    const web = HttpRouter.toWebHandler(
      staticRoutes(webRoot).pipe(HttpRouter.provideRequest(NodeHttpPlatform.layer)),
      { disableLogger: true },
    );
    try {
      const shell = await web.handler(new Request("http://localhost/"));
      assert.strictEqual(shell.status, 200);
      assert.strictEqual(await shell.text(), "<main>usine operator</main>");

      const asset = await web.handler(new Request("http://localhost/assets/app.css"));
      assert.strictEqual(asset.status, 200);
      assert.strictEqual(await asset.text(), ":root { color-scheme: dark; }");

      const missing = await web.handler(new Request("http://localhost/assets/missing.css"));
      assert.strictEqual(missing.status, 404);
    } finally {
      await web.dispose();
      await rm(webRoot, { recursive: true });
    }
  });
});
