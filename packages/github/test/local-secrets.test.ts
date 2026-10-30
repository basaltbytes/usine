import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { InstanceDirectory } from "@usine/core/instance";
import { ConfigProvider, Effect, FileSystem, Layer, Option, Path, Redacted, Schema } from "effect";
import {
  GITHUB_APP_SECRETS_PATH,
  GitHubAppSecretsFromJson,
  loadLocalCredentials,
  loadLocalSecrets,
  writeLocalSecrets,
} from "../src/local-secrets.ts";

const TEST_PRIVATE_KEY = [
  "-----BEGIN PRIVATE KEY-----",
  "AA==",
  "-----END PRIVATE KEY-----",
  "",
].join("\n");

const nodeLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer);

const withInstance = <A, E, R>(use: (root: InstanceDirectory) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = InstanceDirectory.make(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-github-secrets-" }),
    );
    yield* fileSystem.makeDirectory(path.join(root, ".usine"));
    return yield* use(root);
  }).pipe(Effect.scoped, Effect.provide(nodeLayer));

describe("local GitHub App secrets", () => {
  it.effect("loads the 0600 runtime file and keeps the private key redacted", () =>
    withInstance((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(
          path.join(root, GITHUB_APP_SECRETS_PATH),
          JSON.stringify({ app_id: 123, private_key: TEST_PRIVATE_KEY }),
          { mode: 0o600 },
        );

        const loaded = yield* loadLocalCredentials(root);
        assert.strictEqual(loaded.appId, 123);
        assert.strictEqual(Redacted.value(loaded.privateKey), TEST_PRIVATE_KEY);
        assert(!String(loaded).includes(TEST_PRIVATE_KEY));

        const overridden = yield* loadLocalCredentials(root).pipe(
          Effect.provide(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: { USINE_GITHUB_APP_ID: "456" } })),
          ),
        );
        assert.strictEqual(overridden.appId, 456);
        assert.strictEqual(Redacted.value(overridden.privateKey), TEST_PRIVATE_KEY);
      }),
    ),
  );

  it.effect("uses complete environment credentials without touching the file", () =>
    withInstance((root) =>
      Effect.gen(function* () {
        const loaded = yield* loadLocalCredentials(root);
        assert.strictEqual(loaded.appId, 456);
        assert.strictEqual(Redacted.value(loaded.privateKey), TEST_PRIVATE_KEY);
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                USINE_GITHUB_APP_ID: "456",
                USINE_GITHUB_PRIVATE_KEY: TEST_PRIVATE_KEY,
              },
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("rejects a secrets file readable by group or other users", () =>
    withInstance((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(
          path.join(root, GITHUB_APP_SECRETS_PATH),
          JSON.stringify({ app_id: 123, private_key: TEST_PRIVATE_KEY }),
          { mode: 0o644 },
        );

        const failure = yield* loadLocalCredentials(root).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "SecretsFileError");
        if (failure._tag === "SecretsFileError") assert.strictEqual(failure.reason, "permissions");
      }),
    ),
  );
});

it.effect("replaces an insecure old file with complete owner-only secrets", () =>
  withInstance((root) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const target = path.join(root, GITHUB_APP_SECRETS_PATH);
      yield* fs.writeFileString(target, "old", { mode: 0o644 });
      const source = JSON.stringify({
        app_id: 123,
        private_key: TEST_PRIVATE_KEY,
        client_id: "Iv1.test",
        client_secret: "oauth-secret",
        webhook_secret: "hook-secret",
      });
      const secrets = yield* Schema.decodeUnknownEffect(GitHubAppSecretsFromJson)(source);
      yield* writeLocalSecrets(root, secrets);
      assert.equal((yield* fs.stat(target)).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(yield* fs.readFileString(target)), JSON.parse(source));
      const loaded = yield* loadLocalSecrets(root);
      assert.ok(Option.isSome(loaded));
      if (Option.isSome(loaded)) {
        assert.equal(Option.getOrNull(loaded.value.clientId), "Iv1.test");
        assert.ok(!JSON.stringify(loaded.value).includes("oauth-secret"));
        assert.ok(!JSON.stringify(loaded.value).includes("hook-secret"));
      }
      assert.deepEqual(yield* fs.readDirectory(path.dirname(target)), ["github-app.json"]);
    }),
  ),
);
