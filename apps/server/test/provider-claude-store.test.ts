import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { ConfigurationStore } from "@usine/config/configuration";
import { memoryConfigurationLayer } from "@usine/config/memory";
import { ConfigParser } from "@usine/config/parser";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { jsonKey } from "@usine/core/json-key";
import { ConfigProvider, Context, Effect, FileSystem, Layer, Redacted } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { ProviderTargets } from "../src/providers/targets.ts";

it.live("reads native Claude logins and clears an overridden Keychain login on disconnect", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const directory = `${home}/custom claude`;
      yield* fs.makeDirectory(directory);
      const keychain = `${directory}/fixture-keychain`;
      yield* fs.writeFileString(keychain, "fixture-native-secret");
      const native = yield* ChildProcessSpawner.ChildProcessSpawner;
      const commands: string[] = [];
      let logout = "clear";
      const transport = ChildProcessSpawner.make((command) => {
        assert(command._tag === "StandardCommand");
        assert.equal(command.command, "claude");
        assert.deepEqual(command.options.env, {
          HOME: home,
          PATH: home,
          CLAUDE_CONFIG_DIR: directory,
        });
        assert.isFalse(command.options.extendEnv);
        commands.push(command.args.join(" "));
        return native.spawn(
          ChildProcess.make(
            process.execPath,
            [
              "-e",
              `
                const fs = require("node:fs");
                const dir = process.env.CLAUDE_CONFIG_DIR;
                if (process.argv[1] === "logout") {
                  if (process.argv[2] === "fail") process.exit(2);
                  if (process.argv[2] === "clear") fs.rmSync(dir + "/fixture-keychain", { force: true });
                } else {
                  const settings = fs.existsSync(dir + "/settings.json")
                    ? JSON.parse(fs.readFileSync(dir + "/settings.json", "utf8")) : {};
                  const env = settings.env || {};
                  const authMethod = env.CLAUDE_CODE_OAUTH_TOKEN ? "oauth_token"
                    : env.ANTHROPIC_API_KEY ? "api_key"
                    : fs.existsSync(dir + "/fixture-keychain") ? "claude.ai" : "none";
                  console.log(JSON.stringify({ loggedIn: authMethod !== "none", authMethod, apiProvider: "firstParty" }));
                  process.exit(authMethod === "none" ? 1 : 0);
                }
              `,
              command.args[3] ?? "",
              logout,
            ],
            command.options,
          ),
        );
      });
      const store = yield* ConfigurationStore;
      const context = yield* Layer.build(
        ProviderTargets.layer(Effect.succeed([])).pipe(
          Layer.provide(Layer.succeed(ConfigurationStore, store)),
          Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, transport)),
          Layer.provide(
            Layer.succeed(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown({
                HOME: home,
                PATH: home,
                CLAUDE_CONFIG_DIR: directory,
              }),
            ),
          ),
        ),
      );
      const targets = Context.get(context, ProviderTargets);
      const credential = Effect.map(targets.get("local"), ({ providers }) => {
        assert.notInclude(jsonKey(providers), "fixture-native-secret");
        return providers.find(({ provider }) => provider === "anthropic")?.credential;
      });
      const nativeCredential = yield* credential;
      assert.equal(nativeCredential, "subscription");
      for (const kind of ["claude-subscription", "anthropic-api-key"] as const) {
        yield* targets.replace("local", { kind, secret: Redacted.make("fixture-managed-secret") });
        const connectedCredential = yield* credential;
        assert.equal(
          connectedCredential,
          kind === "claude-subscription" ? "subscription" : "api-key",
        );
      }
      yield* fs.writeFileString(
        `${directory}/.credentials.json`,
        '{"claudeAiOauth":{"accessToken":"fixture-old-file-secret"}}',
      );
      yield* targets.disconnect("local", "anthropic");
      const nativeExists = yield* fs.exists(keychain);
      const fileExists = yield* fs.exists(`${directory}/.credentials.json`);
      const disconnectedCredential = yield* credential;
      assert.isFalse(nativeExists);
      assert.isFalse(fileExists);
      assert.equal(disconnectedCredential, null);
      assert.include(commands, "--setting-sources user auth logout");
      assert.include(commands, "--setting-sources user auth status --json");

      yield* fs.writeFileString(keychain, "fixture-native-secret");
      logout = "fail";
      assert.equal(
        (yield* targets.disconnect("local", "anthropic").pipe(Effect.flip))._tag,
        "ProviderCredentialError",
      );
      const failedCredential = yield* credential;
      assert.equal(failedCredential, "subscription");
      logout = "retain";
      const retained = yield* targets.disconnect("local", "anthropic").pipe(Effect.flip);
      assert.include(retained.message, "still signed in");
      const retainedCredential = yield* credential;
      assert.equal(retainedCredential, "subscription");
    }),
  ).pipe(
    Effect.provide(
      memoryConfigurationLayer.pipe(
        Layer.provide(ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer))),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
