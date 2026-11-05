import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { Config, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { LocalProcess } from "../../src/child-host/child-host.ts";
import { AsyncInput, ClaudeSdk, claudeSdkLive } from "../../src/harness/claude/sdk.ts";
import { claudeRuntime } from "../../src/harness/claude/claude.ts";
import { ProbeTarget } from "../../src/harness/runtime.ts";
import { HostLoginLock } from "../../src/runtime.ts";
import { WorkerName } from "@usine/core/worker";

it.live(
  "accepts managed Claude credentials and attributes API-key children despite an older subscription file",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const sdk = yield* ClaudeSdk;
        const runtime = yield* claudeRuntime;
        const path = yield* Config.String("PATH");
        const home = yield* fs.makeTempDirectoryScoped();
        const claudeHome = `${home}/custom claude`;
        yield* fs.makeDirectory(claudeHome);
        const previousLogin = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          claudeAiOauth: {
            accessToken: "fixture-old-token",
            refreshToken: "fixture-old-refresh",
            expiresAt: 4_000_000_000_000,
            scopes: ["user:inference", "user:profile"],
            subscriptionType: "max",
          },
        });
        yield* fs.writeFileString(`${claudeHome}/.credentials.json`, previousLogin, {
          mode: 0o600,
        });
        const environment = { HOME: home, CLAUDE_CONFIG_DIR: claudeHome, PATH: path };
        const brain = BrainSpec.make({
          harness: Harness.make("claude"),
          model: ModelId.make("claude-sonnet-4-6"),
          effort: "low",
        });
        const target = ProbeTarget.make({
          host: LocalProcess.make(),
          environment,
          credential: "host-login",
          worker: WorkerName.make("test-worker"),
          machine: Option.none(),
        });
        for (const [name, usesApiKey] of [
          ["CLAUDE_CODE_OAUTH_TOKEN", false],
          ["ANTHROPIC_API_KEY", true],
        ] as const) {
          const settings = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            env: { [name]: "fixture-not-a-credential" },
          });
          yield* fs.writeFileString(`${claudeHome}/settings.json`, settings, { mode: 0o600 });
          const ready = yield* runtime.preflight(brain, target);
          assert.equal(ready._tag, "HarnessReady");
          assert.equal(ready.harness, "claude");
          yield* Effect.acquireUseRelease(
            Effect.sync(() => {
              const input = new AsyncInput();
              input.end();
              return sdk.open(input, {
                cwd: home,
                env: environment,
                settingSources: ["user"],
                pathToClaudeCodeExecutable: "claude",
              });
            }),
            (query) =>
              Effect.promise(() => query.usesApiKey()).pipe(
                Effect.tap((actual) => Effect.sync(() => assert.equal(actual, usesApiKey))),
              ),
            (query) => Effect.sync(() => query.close()),
          );
        }
        yield* fs.remove(`${claudeHome}/settings.json`);
        yield* fs.remove(`${claudeHome}/.credentials.json`);
        const unavailable = yield* runtime.preflight(brain, target);
        assert.equal(unavailable._tag, "HarnessUnavailableError");
      }),
    ).pipe(
      Effect.provide(claudeSdkLive.pipe(Layer.provideMerge(NodeServices.layer))),
      Effect.provideService(HostLoginLock, { withLock: () => (effect) => effect }),
    ),
  180_000,
);
