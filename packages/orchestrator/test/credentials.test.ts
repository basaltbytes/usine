import { assert, describe, it } from "@effect/vitest";
import { UsineConfig } from "@usine/config/factory";
import { AttemptId } from "@usine/core/attempt";
import type { LoopPermissions } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { CredentialProvider } from "@usine/executor";
import {
  CoveredProject,
  GitHubApiError,
  GitHubApp,
  type GitHubAppError,
  InstallationId,
  InstallationToken,
  RepositoryId,
  SingleRepository,
} from "@usine/github/github-app";
import { DateTime, Effect, Layer, Option, Redacted, Schema } from "effect";
import { gitHubCredentialLayer } from "../src/credentials.ts";
import { fixedConfigLayer } from "./support/current-instance.ts";

const repository = RepositoryName.make("acme/demo");
const config = Schema.decodeUnknownSync(UsineConfig)({
  version: 1,
  repos: [{ name: repository }],
  workers: [{ name: "local", kind: "local" }],
});

describe("GitHub credential provider", () => {
  it.effect("mints each Attempt's token at its Loop's permission level", () => {
    const requested: Array<LoopPermissions> = [];
    const project = new CoveredProject({
      installationId: InstallationId.make(77),
      repository,
      repositoryId: RepositoryId.make(99),
    });
    const app = Layer.succeed(GitHubApp)({
      installation: () => Effect.die("unused"),
      repositories: () => Effect.die("unused installation repositories"),
      installationToken: () => Effect.die("unused"),
      botAccount: () => Effect.die("unused"),
      projectAccess: () => Effect.succeed([project]),
      deliveries: () => Effect.die("unused webhook deliveries"),
      workerToken: (_project, permissions) =>
        Effect.sync(() => {
          requested.push(permissions);
          return new InstallationToken({
            value: Redacted.make(`ghs_${permissions}`),
            expiresAt: DateTime.makeUnsafe(3_600_000),
            scope: new SingleRepository({
              repository,
              repositoryId: project.repositoryId,
              permissions,
            }),
          });
        }),
    });
    return Effect.gen(function* () {
      const provider = yield* CredentialProvider;
      const read = yield* provider.issue(repository, AttemptId.make("review/1"), "read");
      const write = yield* provider.issue(repository, AttemptId.make("implement/1"), "write");
      assert.deepStrictEqual(requested, ["read", "write"]);
      assert.strictEqual(Redacted.value(read.value), "ghs_read");
      assert.strictEqual(Redacted.value(write.value), "ghs_write");
    }).pipe(
      Effect.provide(
        gitHubCredentialLayer.pipe(Layer.provide(app), Layer.provide(fixedConfigLayer(config))),
      ),
    );
  });
});

describe("GitHub credential provider failures", () => {
  const project = new CoveredProject({
    installationId: InstallationId.make(77),
    repository,
    repositoryId: RepositoryId.make(99),
  });
  const provider = (projects: ReadonlyArray<CoveredProject>, mint: GitHubAppError) =>
    gitHubCredentialLayer.pipe(
      Layer.provide(
        Layer.succeed(GitHubApp)({
          installation: () => Effect.die("unused"),
          repositories: () => Effect.die("unused installation repositories"),
          installationToken: () => Effect.die("unused"),
          botAccount: () => Effect.die("unused"),
          projectAccess: () => Effect.succeed(projects),
          deliveries: () => Effect.die("unused webhook deliveries"),
          workerToken: () => Effect.fail(mint),
        }),
      ),
      Layer.provide(fixedConfigLayer(config)),
    );
  const issue = CredentialProvider.use((credentials) =>
    credentials.issue(repository, AttemptId.make("implement/1"), "write"),
  ).pipe(Effect.flip);

  it.effect("reports a mint GitHub refuses as refused, with GitHub's reason", () =>
    Effect.gen(function* () {
      const failure = yield* issue;
      assert.strictEqual(failure.reason, "refused");
      assert.strictEqual(
        failure.message,
        'Could not create a worker token for "acme/demo": GitHub returned HTTP status 422: The permissions requested are not granted to this installation.',
      );
    }).pipe(
      Effect.provide(
        provider(
          [project],
          new GitHubApiError({
            operation: "mint-worker-token",
            status: Option.some(422),
            message:
              "GitHub returned HTTP status 422: The permissions requested are not granted to this installation.",
          }),
        ),
      ),
    ),
  );

  it.effect("reports a repository the installation does not cover as refused", () =>
    Effect.gen(function* () {
      const failure = yield* issue;
      assert.strictEqual(failure.reason, "refused");
      assert.strictEqual(
        failure.message,
        'The GitHub App installation has no access to "acme/demo"',
      );
    }).pipe(
      Effect.provide(
        provider(
          [],
          new GitHubApiError({
            operation: "mint-worker-token",
            status: Option.none(),
            message: "unused",
          }),
        ),
      ),
    ),
  );

  it.effect("reports a mint GitHub could not answer as unreachable", () =>
    Effect.gen(function* () {
      const failure = yield* issue;
      assert.strictEqual(failure.reason, "unreachable");
      assert.strictEqual(
        failure.message,
        'Could not create a worker token for "acme/demo": Could not send the request to GitHub',
      );
    }).pipe(
      Effect.provide(
        provider(
          [project],
          new GitHubApiError({
            operation: "mint-worker-token",
            status: Option.none(),
            message: "Could not send the request to GitHub",
          }),
        ),
      ),
    ),
  );
});
