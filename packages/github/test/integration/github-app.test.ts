import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { RepositoryName } from "@usine/core/repository";
import { InstanceDirectory } from "@usine/core/instance";
import { Config, Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { GitHubApp } from "../../src/github-app.ts";
import { localSecretsLayer } from "../../src/local-secrets.ts";

const API_VERSION = "2026-03-10";
const PositiveIntFromString = Schema.FiniteFromString.pipe(
  Schema.decodeTo(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
);
const Comment = Schema.Struct({
  id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  user: Schema.Struct({ login: Schema.NonEmptyString }),
});

const fetchJson = Effect.fn("integration.fetchJson")(function* <S extends Schema.Constraint>(
  url: string,
  token: string,
  init: RequestInit,
  schema: S,
) {
  const response = yield* Effect.tryPromise(() =>
    fetch(url, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": API_VERSION,
      },
    }),
  );
  if (!response.ok) return yield* Effect.die(`GitHub returned ${response.status}`);
  return yield* Schema.decodeUnknownEffect(schema)(yield* Effect.promise(() => response.json()));
});

const deleteComment = Effect.fn("integration.deleteComment")(function* (
  repository: RepositoryName,
  commentId: number,
  token: string,
) {
  const response = yield* Effect.tryPromise(() =>
    fetch(`https://api.github.com/repos/${repository}/issues/comments/${commentId}`, {
      method: "DELETE",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": API_VERSION,
      },
    }),
  );
  if (response.status !== 204) return yield* Effect.die(`GitHub returned ${response.status}`);
});

describe("operator-created GitHub App", () => {
  it.live("mints both token shapes and records the App bot identity", () =>
    Effect.gen(function* () {
      const settings = yield* Effect.all({
        instanceDirectory: Config.string("USINE_GITHUB_INTEGRATION_INSTANCE_DIRECTORY"),
        repository: Config.string("USINE_GITHUB_INTEGRATION_REPO"),
        issueNumber: Config.schema(PositiveIntFromString, "USINE_GITHUB_INTEGRATION_ISSUE_NUMBER"),
        botLogin: Config.string("USINE_GITHUB_INTEGRATION_BOT_LOGIN"),
      });
      const root = InstanceDirectory.make(settings.instanceDirectory);
      const repository = RepositoryName.make(settings.repository);
      const platformLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer);
      const credentialsLayer = localSecretsLayer(root).pipe(Layer.provide(platformLayer));
      const githubLayer = GitHubApp.layer.pipe(
        Layer.provide(credentialsLayer),
        Layer.provide(FetchHttpClient.layer),
      );

      yield* Effect.gen(function* () {
        const app = yield* GitHubApp;
        const installationToken = yield* app.installationToken();
        assert.strictEqual(installationToken.scope._tag, "InstallationWide");

        const access = yield* app.projectAccess([repository]);
        const project = access[0];
        assert(project !== undefined && project._tag === "CoveredProject");
        const workerToken = yield* app.workerToken(project);
        assert.strictEqual(workerToken.scope._tag, "SingleRepository");

        const token = Redacted.value(workerToken.value);
        yield* Effect.acquireUseRelease(
          fetchJson(
            `https://api.github.com/repos/${repository}/issues/${settings.issueNumber}/comments`,
            token,
            {
              method: "POST",
              body: JSON.stringify({
                body: "usine @usine/github integration check; this comment is removed automatically.",
              }),
            },
            Comment,
          ),
          (comment) =>
            Effect.sync(() => {
              assert.strictEqual(comment.user.login, settings.botLogin);
              assert.match(comment.user.login, /\[bot\]$/u);
            }),
          (comment) => deleteComment(repository, comment.id, token),
        );
      }).pipe(Effect.provide(githubLayer));
    }),
  );
});
