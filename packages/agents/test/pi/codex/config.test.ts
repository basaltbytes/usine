import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { AgentSessionId } from "@usine/core/agent/session";
import { Config, Effect, Fiber, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
// The version probe determines whether the pinned CLI is available for these tests.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LocalProcess, RemoteShell } from "../../../src/child-host/child-host.ts";
import {
  CodexAppServer,
  codexAppServerCommand,
  codexAppServerLive,
} from "../../../src/harness/codex/app-server.ts";
import { initializeCodex } from "../../../src/harness/codex/account.ts";
import { CODEX_CLI_VERSION } from "../../../src/harness/codex/descriptor.ts";
import { WorkingDirectory } from "../../../src/runtime.ts";

const pinnedCli =
  spawnSync("codex", ["--version"], { encoding: "utf8" }).stdout?.trim() ===
  `codex-cli ${CODEX_CLI_VERSION}`;

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "usine-codex-config-" });
  const home = `${directory}/home`;
  const codexHome = `${directory}/codex`;
  const cwd = WorkingDirectory.make(`${home}/repo.with dots'quote"and\\backslash`);
  for (const path of [`${home}/.codex`, codexHome, `${cwd}/.git`, `${cwd}/.codex`])
    yield* fs.makeDirectory(path, { recursive: true });
  yield* fs.writeFileString(`${cwd}/.codex/config.toml`, 'model = "repository-model"\n');
  const quotedCwd = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(cwd);
  yield* fs.writeFileString(
    `${codexHome}/config.toml`,
    `model = "user-model"\n[projects.${quotedCwd}]\ntrust_level = "trusted"\n`,
  );
  const path = yield* Config.String("PATH");
  return { cwd, environment: { PATH: path, HOME: home, CODEX_HOME: codexHome } };
});

const Model = Schema.Struct({ model: Schema.String });
const ConfigResponse = Schema.Struct({ config: Model });
const Warning = Schema.Struct({ summary: Schema.String });
const liveLayer = codexAppServerLive.pipe(Layer.provideMerge(NodeServices.layer));

describe.skipIf(!pinnedCli)("Codex configuration with the pinned CLI", () => {
  it.live("accepts every launch override under strict configuration parsing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* fixture;
        const command = codexAppServerCommand({
          ...client,
          host: LocalProcess.make(),
          sessionId: Option.none(),
        });
        assert.strictEqual(command._tag, "StandardCommand");
        if (command._tag !== "StandardCommand") return;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const handle = yield* spawner.spawn(
          ChildProcess.make(command.command, [...command.args, "--strict-config"], {
            ...command.options,
            stdin: "ignore",
          }),
        );
        const [exitCode, stderr] = yield* Effect.all(
          [
            handle.exitCode,
            handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
            handle.stdout.pipe(Stream.runDrain),
          ],
          { concurrency: "unbounded" },
        );
        assert.strictEqual(exitCode, 0, stderr);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  for (const remote of [false, true]) {
    it.live(
      `keeps an already trusted checkout's project config disabled ${remote ? "over SSH" : "locally"}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* fixture;
            const server = yield* CodexAppServer;
            const connection = yield* server.open({
              ...client,
              sessionId: Option.some(AgentSessionId.make("parent:config:child:1")),
              host: remote
                ? RemoteShell.make({
                    ssh: {
                      command: fileURLToPath(
                        new URL("../../fixtures/ssh-shim.sh", import.meta.url),
                      ),
                      args: [],
                    },
                    sshEnvironment: client.environment,
                    destination: "worker.example",
                  })
                : LocalProcess.make(),
            });
            const notifications = yield* Stream.runCollect(connection.notifications).pipe(
              Effect.forkChild,
            );
            yield* initializeCodex(connection);
            const config = yield* connection.request("launch", "config/read", {
              cwd: client.cwd,
              includeLayers: false,
            });
            const decoded = yield* Schema.decodeUnknownEffect(ConfigResponse)(config);
            assert.strictEqual(decoded.config.model, "user-model");
            const thread = yield* connection.request("launch", "thread/start", {
              cwd: client.cwd,
              approvalPolicy: "never",
              sandbox: "danger-full-access",
            });
            const started = yield* Schema.decodeUnknownEffect(Model)(thread);
            assert.strictEqual(started.model, "user-model");
            yield* connection.close;
            for (const notification of yield* Fiber.join(notifications)) {
              if (notification.method !== "configWarning") continue;
              const warning = yield* Schema.decodeUnknownEffect(Warning)(notification.params);
              assert.notInclude(warning.summary, "unrecognized configuration setting");
              assert.notInclude(
                warning.summary,
                "Project-local config, hooks, and exec policies are disabled",
              );
            }
          }),
        ).pipe(Effect.provide(liveLayer)),
      30_000,
    );
  }
});
