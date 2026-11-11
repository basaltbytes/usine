import { jsonKey } from "@usine/core/json-key";
import { CommitSha, RepositoryName } from "@usine/core/repository";
import { DateTime, Effect, Layer, Redacted, type Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { GitHubApp } from "../../src/github-app.ts";
import { GitHubChecks } from "../../src/checks.ts";
import {
  AppSlug,
  Installation,
  InstallationId,
  InstallationToken,
  InstallationWide,
} from "../../src/installation.ts";

export const repository = RepositoryName.make("basaltbytes/usine");
const token = InstallationToken.make({
  value: Redacted.make("item-writer-token"),
  expiresAt: DateTime.makeUnsafe("2026-09-01T22:00:00Z"),
  scope: InstallationWide.make(),
});

export const appLayer = Layer.succeed(GitHubApp)({
  installation: Effect.succeed(
    Installation.make({
      id: InstallationId.make(77),
      accountLogin: "basaltbytes",
      appSlug: AppSlug.make("usine-basaltbytes"),
    }),
  ),
  repositories: Effect.die("unused installation repositories"),
  installationToken: Effect.succeed(token),
  botAccount: Effect.die("unused"),
  projectAccess: () => Effect.die("unused"),
  installationUrl: Effect.die("unused installation URL"),
  configureWebhook: () => Effect.die("unused webhook configuration"),
  deliveries: () => Effect.die("unused webhook deliveries"),
  workerToken: () => Effect.die("unused"),
});

export const head = CommitSha.make("a".repeat(40));
export const withClient = (respond: (url: string) => Response) =>
  GitHubChecks.layer.pipe(
    Layer.provide(appLayer),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, respond(request.url))),
        ),
      ),
    ),
  );
export const json = (value: Schema.Json) =>
  new Response(jsonKey(value), {
    headers: { "content-type": "application/json" },
  });
