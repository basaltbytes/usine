import { Loop, Run } from "@usine/core";
import { NeedsSetupOverview } from "@usine/orchestrator";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { afterAll, assert, describe, it } from "vitest";
import { BackendUnavailableError, FactoryBackend } from "../src/backend.ts";
import { apiRoutes } from "../src/http.ts";

const unavailable = () =>
  Effect.fail(new BackendUnavailableError({ message: "GitHub App setup is required." }));

const backend = Layer.succeed(FactoryBackend)({
  overview: Effect.succeed(
    new NeedsSetupOverview({
      message: "Add GitHub App credentials.",
      errorTag: "SecretsFileError",
      projects: [],
      loops: [],
      needsYou: [],
    }),
  ),
  detail: unavailable,
  approve: unavailable,
  retry: unavailable,
  cancel: unavailable,
  pause: (_loop: Loop.LoopName) => unavailable(),
  unpause: (_loop: Loop.LoopName) => unavailable(),
});

const app = HttpRouter.toWebHandler(apiRoutes.pipe(HttpRouter.provideRequest(backend)), {
  disableLogger: true,
});

afterAll(() => app.dispose());

describe("operator HTTP API", () => {
  it("serves typed needs-setup state while intervention remains unavailable", async () => {
    const overview = await app.handler(new Request("http://localhost/api/overview"));
    assert.strictEqual(overview.status, 200);
    assert.deepStrictEqual(await overview.json(), {
      _tag: "NeedsSetup",
      message: "Add GitHub App credentials.",
      errorTag: "SecretsFileError",
      projects: [],
      loops: [],
      needsYou: [],
    });

    const action = await app.handler(
      new Request(`http://localhost/api/runs/${Run.RunId.make("run-1")}/approve`, {
        method: "POST",
      }),
    );
    assert.strictEqual(action.status, 503);
    assert.deepStrictEqual(await action.json(), {
      error: "BackendUnavailableError",
      message: "GitHub App setup is required.",
    });
  });
});
