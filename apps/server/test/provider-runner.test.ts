import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { ConfigProvider, Context, Effect, FileSystem, Layer, Redacted } from "effect";
import { ProviderLoginRunner, providerLoginRunnerLayer } from "../src/providers/runner.ts";

it.live("drains native login output before completing and removes isolated credentials", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(
        `${directory}/codex`,
        `#!/bin/sh
printf '%s\\n' 'https://auth.openai.com/codex/device' 'ABCD-EFGH'
printf '%s' "$CODEX_HOME" > "$HOME/login-directory"
printf '%s' '{"tokens":{"access_token":"private-access","refresh_token":"private-refresh"}}' > "$CODEX_HOME/auth.json"
`,
        { mode: 0o700 },
      );
      yield* fs.writeFileString(
        `${directory}/claude`,
        `#!/bin/sh
printf '%s\\n' 'https://claude.com/cai/oauth/authorize?state=fixture&code_challenge=fixture'
read -r code
[ "$code" = 'authorization-code' ] || exit 1
printf '%s\\n' 'sk-ant-oat01-private-subscription-token'
`,
        { mode: 0o700 },
      );
      const context = yield* Layer.build(
        providerLoginRunnerLayer.pipe(
          Layer.provide(NodeServices.layer),
          Layer.provide(
            Layer.succeed(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown({ HOME: directory, PATH: `${directory}:/usr/bin:/bin` }),
            ),
          ),
        ),
      );
      const runner = Context.get(context, ProviderLoginRunner);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const login = yield* runner.start("chatgpt");
          const prompt = yield* login.prompt;
          assert.deepEqual(prompt, {
            url: "https://auth.openai.com/codex/device",
            code: "ABCD-EFGH",
          });
          const credential = yield* login.result;
          assert.equal(credential.kind, "chatgpt-subscription");
          assert.include(Redacted.value(credential.secret), "private-refresh");
        }),
      );
      const temporary = yield* fs.readFileString(`${directory}/login-directory`);
      const exists = yield* fs.exists(temporary);
      assert.isFalse(exists);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const login = yield* runner.start("claude");
          const prompt = yield* login.prompt;
          assert.deepEqual(prompt, {
            url: "https://claude.com/cai/oauth/authorize?state=fixture&code_challenge=fixture",
            code: null,
          });
          yield* login.submit(Redacted.make("authorization-code"));
          const credential = yield* login.result;
          assert.equal(credential.kind, "claude-subscription");
          assert.equal(
            Redacted.value(credential.secret),
            "sk-ant-oat01-private-subscription-token",
          );
        }),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer), Effect.timeout("20 seconds")),
);
