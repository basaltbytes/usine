import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { codexRuntime } from "../../src/harness/codex/codex.ts";
import { ProbeTarget } from "../../src/harness/runtime.ts";
import { WorkerName } from "@usine/core/worker";
import { AgentSessionId } from "@usine/core/agent/session";
import { Config, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { LocalProcess } from "../../src/child-host/child-host.ts";
import { initializeCodex, verifyCodexAccount } from "../../src/harness/codex/account.ts";
import { CodexAppServer, codexAppServerLive } from "../../src/harness/codex/app-server.ts";
import { WorkingDirectory } from "../../src/runtime.ts";
import { AccountResponse } from "../../src/protocol/codex/codex.ts";

it.live(
  "local preflight and children use the managed file with keyring storage configured, including after disconnect",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const server = yield* CodexAppServer;
        const runtime = yield* codexRuntime;
        const path = yield* Config.String("PATH");
        const home = yield* fs.makeTempDirectoryScoped();
        const codexHome = `${home}/custom codex`;
        yield* fs.makeDirectory(codexHome);
        yield* fs.writeFileString(
          `${codexHome}/config.toml`,
          'cli_auth_credentials_store = "keyring"\n',
        );
        const authFile = `${codexHome}/auth.json`;
        const account = (sessionId: Option.Option<AgentSessionId>) =>
          Effect.scoped(
            Effect.gen(function* () {
              const connection = yield* server.open({
                cwd: WorkingDirectory.make(home),
                sessionId,
                environment: { HOME: home, CODEX_HOME: codexHome, PATH: path },
                host: LocalProcess.make(),
              });
              yield* initializeCodex(connection);
              const auth = yield* connection
                .request("launch", "account/read", { refreshToken: false })
                .pipe(Effect.flatMap(Schema.decodeUnknownEffect(AccountResponse)));
              if (auth.account !== null) {
                const billing = yield* verifyCodexAccount(
                  connection,
                  ModelId.make("gpt-5.6-terra"),
                );
                assert.equal(billing.pool, "apiKeys");
              }
              return auth;
            }),
          );
        for (const sessionId of [
          Option.none<AgentSessionId>(),
          Option.some(AgentSessionId.make("credential-store:child:1")),
        ]) {
          yield* fs.writeFileString(authFile, '{"OPENAI_API_KEY":"fixture-key-not-a-credential"}', {
            mode: 0o600,
          });
          const ready = yield* runtime.preflight(
            BrainSpec.make({
              harness: Harness.make("codex"),
              model: ModelId.make("gpt-5.6-terra"),
              effort: "low",
            }),
            ProbeTarget.make({
              host: LocalProcess.make(),
              environment: { HOME: home, CODEX_HOME: codexHome, PATH: path },
              credential: "host-login",
              worker: WorkerName.make("test-worker"),
              machine: Option.none(),
            }),
          );
          assert.equal(ready._tag, "HarnessReady");
          assert.equal(ready.harness, "codex");
          const connected = yield* account(sessionId);
          assert.deepEqual(connected, {
            account: { type: "apiKey" },
            requiresOpenaiAuth: true,
          });
          yield* fs.remove(authFile);
          const unavailable = yield* runtime.preflight(
            BrainSpec.make({
              harness: Harness.make("codex"),
              model: ModelId.make("gpt-5.6-terra"),
              effort: "low",
            }),
            ProbeTarget.make({
              host: LocalProcess.make(),
              environment: { HOME: home, CODEX_HOME: codexHome, PATH: path },
              credential: "host-login",
              worker: WorkerName.make("test-worker"),
              machine: Option.none(),
            }),
          );
          assert.equal(unavailable._tag, "HarnessUnavailableError");
          const disconnected = yield* account(sessionId);
          assert.deepEqual(disconnected, {
            account: null,
            requiresOpenaiAuth: true,
          });
        }
        const configuration = yield* fs.readFileString(`${codexHome}/config.toml`);
        assert.equal(configuration, 'cli_auth_credentials_store = "keyring"\n');
      }),
    ).pipe(Effect.provide(codexAppServerLive.pipe(Layer.provideMerge(NodeServices.layer)))),
  30_000,
);
