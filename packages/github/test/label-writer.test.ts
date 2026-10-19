import { assert, describe, it } from "@effect/vitest";
import { RepositoryName } from "@usine/core/repository";
import { DateTime, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { GitHubApp } from "../src/github-app.ts";
import { GitHubLabelWriter, NewRepositoryLabel } from "../src/label-writer.ts";
import {
  AppSlug,
  Installation,
  InstallationId,
  InstallationToken,
  InstallationWide,
} from "../src/installation.ts";
import { RepositoryLabelColor, RepositoryLabelName } from "../src/polling/labels.ts";

const repository = RepositoryName.make("basaltbytes/usine");
const token = new InstallationToken({
  value: Redacted.make("label-writer-token"),
  expiresAt: DateTime.makeUnsafe("2026-09-01T22:00:00Z"),
  scope: new InstallationWide(),
});
const appLayer = Layer.succeed(GitHubApp)({
  installation: () =>
    Effect.succeed(
      new Installation({
        id: InstallationId.make(77),
        accountLogin: "basaltbytes",
        appSlug: AppSlug.make("usine-basaltbytes"),
      }),
    ),
  installationToken: () => Effect.succeed(token),
  projectAccess: () => Effect.die("unused"),
  workerToken: () => Effect.die("unused"),
});

const RequestBody = Schema.Struct({
  name: Schema.String,
  color: Schema.String,
  description: Schema.String,
});

describe("GitHubLabelWriter", () => {
  it.effect("creates a repository label with the App-scoped installation token", () => {
    let sent: HttpClientRequest.HttpClientRequest | undefined;
    const client = HttpClient.make((request) => {
      sent = request;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              name: "ready-for-agent",
              color: "A2EEEF",
              description: "Ready for an agent to claim",
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          ),
        ),
      );
    });
    const layer = GitHubLabelWriter.layer.pipe(
      Layer.provide(appLayer),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    );

    return Effect.gen(function* () {
      const writer = yield* GitHubLabelWriter;
      const created = yield* writer.create(
        repository,
        new NewRepositoryLabel({
          name: RepositoryLabelName.make("ready-for-agent"),
          color: Option.some(RepositoryLabelColor.make("A2EEEF")),
          description: Option.some("Ready for an agent to claim"),
        }),
      );

      assert(sent !== undefined);
      assert.strictEqual(sent.method, "POST");
      assert.strictEqual(sent.url, "https://api.github.com/repos/basaltbytes/usine/labels");
      assert.strictEqual(sent.headers.authorization, "Bearer label-writer-token");
      assert.strictEqual(sent.body._tag, "Uint8Array");
      if (sent.body._tag !== "Uint8Array") return;
      assert.deepStrictEqual(
        Schema.decodeUnknownSync(RequestBody)(JSON.parse(new TextDecoder().decode(sent.body.body))),
        {
          name: "ready-for-agent",
          color: "A2EEEF",
          description: "Ready for an agent to claim",
        },
      );
      assert.strictEqual(created.name, "ready-for-agent");
      assert.strictEqual(created.color, "A2EEEF");
      assert.strictEqual(Option.getOrNull(created.description), "Ready for an agent to claim");
    }).pipe(Effect.provide(layer));
  });
});
