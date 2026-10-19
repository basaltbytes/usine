import { assert, describe, it } from "@effect/vitest";
import { UsineConfig } from "@usine/config/factory";
import { AttemptId } from "@usine/core/attempt";
import type { LoopPermissions } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { CredentialProvider } from "@usine/executor";
import {
  CoveredProject,
  GitHubApp,
  InstallationId,
  InstallationToken,
  RepositoryId,
  SingleRepository,
} from "@usine/github/github-app";
import { DateTime, Effect, Layer, Redacted, Schema } from "effect";
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
      installationToken: () => Effect.die("unused"),
      projectAccess: () => Effect.succeed([project]),
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
