import { assert, describe, it } from "@effect/vitest";
import { RepositoryName } from "@usine/core/repository";
import { ItemNumber } from "@usine/core/item";
import { DateTime, Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { GitHubApp } from "../src/github-app.ts";
import { GitHubItemWriter, ItemLabelMutation } from "../src/item-writer.ts";
import { Installation, InstallationId, InstallationToken, InstallationWide } from "../src/model.ts";

const repository = RepositoryName.make("basaltbytes/usine");
const token = new InstallationToken({
  value: Redacted.make("item-writer-token"),
  expiresAt: DateTime.makeUnsafe("2026-09-01T22:00:00Z"),
  scope: new InstallationWide(),
});

const appLayer = Layer.succeed(GitHubApp)({
  installation: () =>
    Effect.succeed(new Installation({ id: InstallationId.make(77), accountLogin: "basaltbytes" })),
  installationToken: () => Effect.succeed(token),
  projectAccess: () => Effect.die("unused"),
  workerToken: () => Effect.die("unused"),
});

const LabelRequest = Schema.Struct({ labels: Schema.Array(Schema.String) });

describe("GitHubItemWriter", () => {
  it.effect("mutates only lane labels while preserving truncated and concurrent labels", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    // The polled Item slice would expose only the first 50 of these labels.
    const unrelated = Array.from({ length: 60 }, (_, index) => `unrelated-${index}`);
    const current = new Set([...unrelated, "ready"]);
    let concurrentAdded = false;
    const client = HttpClient.make((request) => {
      requests.push(request);
      if (request.method === "POST") {
        assert.strictEqual(request.body._tag, "Uint8Array");
        if (request.body._tag === "Uint8Array") {
          const body = Schema.decodeUnknownSync(LabelRequest)(
            JSON.parse(new TextDecoder().decode(request.body.body)),
          );
          body.labels.forEach((label) => current.add(label));
        }
        // Simulate an unrelated label arriving after the stale projection and
        // during the multi-request lane move.
        current.add("concurrent-label");
        concurrentAdded = true;
      } else if (request.method === "DELETE") {
        const removed = current.delete(decodeURIComponent(request.url.split("/").at(-1) ?? ""));
        if (!removed) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })),
          );
        }
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify([...current].map((name) => ({ name }))), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    });
    const layer = GitHubItemWriter.layer.pipe(
      Layer.provide(appLayer),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    );

    return Effect.gen(function* () {
      const writer = yield* GitHubItemWriter;
      const applied = yield* writer.updateLabels(
        repository,
        ItemNumber.make(33),
        new ItemLabelMutation({
          add: ["ready-for-review"],
          remove: ["ready", "stale-lane-label"],
        }),
      );
      assert.strictEqual(concurrentAdded, true);
      assert.strictEqual(requests.length, 3);
      assert.deepStrictEqual(
        requests.map(({ method }) => method),
        ["POST", "DELETE", "DELETE"],
      );
      const addRequest = requests[0];
      assert(addRequest !== undefined);
      assert.strictEqual(
        addRequest.url,
        "https://api.github.com/repos/basaltbytes/usine/issues/33/labels",
      );
      assert.strictEqual(addRequest.headers.authorization, "Bearer item-writer-token");
      assert.strictEqual(addRequest.body._tag, "Uint8Array");
      if (addRequest.body._tag !== "Uint8Array") return;
      const body = Schema.decodeUnknownSync(LabelRequest)(
        JSON.parse(new TextDecoder().decode(addRequest.body.body)),
      );
      assert.deepStrictEqual(body.labels, ["ready-for-review"]);
      assert.strictEqual(
        requests[1]?.url,
        "https://api.github.com/repos/basaltbytes/usine/issues/33/labels/ready",
      );
      assert.strictEqual(
        requests[2]?.url,
        "https://api.github.com/repos/basaltbytes/usine/issues/33/labels/stale-lane-label",
      );
      assert.strictEqual(applied.includes("ready"), false);
      assert.strictEqual(applied.includes("ready-for-review"), true);
      assert.strictEqual(applied.includes("concurrent-label"), true);
      assert(unrelated.every((label) => applied.includes(label)));
    }).pipe(Effect.provide(layer));
  });
});
