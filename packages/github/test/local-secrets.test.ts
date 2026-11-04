import { jsonKey } from "@usine/core/json-key";
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
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "usine-github-secrets-",
    });
    const root = InstanceDirectory.make(directory);
    yield* fileSystem.makeDirectory(path.join(root, ".usine"));
    return yield* use(root);
  }).pipe(Effect.scoped, Effect.provide(nodeLayer));

describe("local GitHub App secrets", () => {
  it.effect("loads the 0600 runtime file and keeps the private key redacted", () =>
    withInstance((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const json1 = jsonKey({
          app_id: 123,
          private_key: TEST_PRIVATE_KEY,
        });
        yield* fileSystem.writeFileString(path.join(root, GITHUB_APP_SECRETS_PATH), json1, {
          mode: 0o600,
        });

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
        const json2 = jsonKey({
          app_id: 123,
          private_key: TEST_PRIVATE_KEY,
        });
        yield* fileSystem.writeFileString(path.join(root, GITHUB_APP_SECRETS_PATH), json2, {
          mode: 0o644,
        });

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
      const json3 = jsonKey({
        app_id: 123,
        private_key: TEST_PRIVATE_KEY,
        client_id: "Iv1.test",
        client_secret: "oauth-secret",
        webhook_secret: "hook-secret",
      });
      const source = json3;
      const secrets = yield* Schema.decodeEffect(GitHubAppSecretsFromJson)(source);
      yield* writeLocalSecrets(root, secrets);
      assert.equal((yield* fs.stat(target)).mode & 0o777, 0o600);
      const contents = yield* fs.readFileString(target);
      const json4 = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(contents).pipe(
        Effect.orDie,
      );
      const json5 = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(source).pipe(
        Effect.orDie,
      );
      assert.deepEqual(json4, json5);
      const loaded = yield* loadLocalSecrets(root);
      assert.ok(Option.isSome(loaded));
      if (Option.isSome(loaded)) {
        assert.equal(Option.getOrNull(loaded.value.clientId), "Iv1.test");
        const json6 = jsonKey(loaded.value);
        assert.ok(!json6.includes("oauth-secret"));
        const json7 = jsonKey(loaded.value);
        assert.ok(!json7.includes("hook-secret"));
      }
      const entries = yield* fs.readDirectory(path.dirname(target));
      assert.deepEqual(entries, ["github-app.json"]);
    }),
  ),
);
