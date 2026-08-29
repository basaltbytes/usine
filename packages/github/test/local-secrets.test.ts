import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Instance } from "@usine/core";
import { ConfigProvider, Effect, FileSystem, Layer, Path, Redacted } from "effect";
import { GITHUB_APP_SECRETS_PATH, loadLocalCredentials } from "../src/local-secrets.ts";

const TEST_PRIVATE_KEY = [
  "-----BEGIN PRIVATE KEY-----",
  "AA==",
  "-----END PRIVATE KEY-----",
  "",
].join("\n");

const nodeLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer);

const withInstance = <A, E, R>(use: (root: Instance.Directory) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = Instance.Directory.make(
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
