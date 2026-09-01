import { assert, describe, it } from "@effect/vitest";
import { Item, Repository } from "@usine/core";
import { DateTime, Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import {
  GitHubApp,
  GitHubItemWriter,
  Installation,
  InstallationId,
  InstallationToken,
  InstallationWide,
} from "../src/index.ts";

const repository = Repository.Name.make("basaltbytes/usine");
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
  it.effect("replaces an issue or pull request's labels in one idempotent request", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const client = HttpClient.make((request) => {
      requests.push(request);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify([{ name: "ready-for-review" }, { name: "bug" }]), {
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
      const applied = yield* writer.setLabels(repository, Item.Number.make(33), [
        "ready-for-review",
        "bug",
      ]);
      assert.deepStrictEqual(applied, ["ready-for-review", "bug"]);
      const request = requests[0];
      assert(request !== undefined);
      assert.strictEqual(request.method, "PUT");
      assert.strictEqual(
        request.url,
        "https://api.github.com/repos/basaltbytes/usine/issues/33/labels",
      );
      assert.strictEqual(request.headers.authorization, "Bearer item-writer-token");
      assert.strictEqual(request.body._tag, "Uint8Array");
      if (request.body._tag !== "Uint8Array") return;
      const body = Schema.decodeUnknownSync(LabelRequest)(
        JSON.parse(new TextDecoder().decode(request.body.body)),
      );
      assert.deepStrictEqual(body.labels, ["ready-for-review", "bug"]);
    }).pipe(Effect.provide(layer));
  });
});
