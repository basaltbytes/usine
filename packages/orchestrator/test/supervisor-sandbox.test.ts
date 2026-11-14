import { NodeFileSystem } from "@effect/platform-node";
import { UsineConfig } from "@usine/config/factory";
import { LoadedInstance } from "@usine/config/instance";
import { InstanceDirectory, InstanceId } from "@usine/core/instance";
import { AgentSessionId } from "@usine/core/agent/session";
import { Harness, ModelId } from "@usine/core/agent/brain";
import { SupervisorSandbox, SandboxRequest } from "@usine/agents/supervisor";
import { Context, FileSystem, Layer, Schema, Stream } from "effect";
import { spawning } from "../../executor/test/supervisor/runtime-fixture.ts";
import { CurrentInstance } from "../src/current-instance/current-instance.ts";
import { supervisorSandboxLayer } from "../src/supervisor-sandbox.ts";
import { TestClock } from "effect/testing";
import { assert, describe, it } from "@effect/vitest";
import { SupervisorUnavailable } from "@usine/agents/supervisor";
import { Effect, Logger, Option } from "effect";
import { reportSupervisorAvailability } from "../src/supervisor-sandbox.ts";

const warningsIn = (warnings: Array<unknown>) =>
  Logger.make<unknown, void>(({ logLevel, message }) => {
    if (logLevel === "Warn") warnings.push(message);
  });

const unavailable = {
  unavailable: Option.some(
    SupervisorUnavailable.make({
      message:
        "Supervisor sessions run in a container, and Podman or Docker isn't installed on the orchestrator host",
    }),
  ),
  open: () => Effect.die("the test opens no sandbox"),
};

const available = { unavailable: Option.none(), open: unavailable.open };

describe("the supervisor's availability at startup", () => {
  it.effect("warns, with the reason, when the configured supervisor can't run", () =>
    Effect.gen(function* () {
      const warnings: Array<unknown> = [];
      yield* reportSupervisorAvailability(true, unavailable).pipe(
        Effect.withLogger(warningsIn(warnings)),
      );
      assert.deepStrictEqual(warnings, [
        [
          "The configured supervisor is unavailable on this orchestrator",
          {
            reason:
              "Supervisor sessions run in a container, and Podman or Docker isn't installed on the orchestrator host",
          },
        ],
      ]);
    }),
  );

  it.effect("doesn't warn without a configured supervisor, or when it can run", () =>
    Effect.gen(function* () {
      const warnings: Array<unknown> = [];
      yield* reportSupervisorAvailability(false, unavailable).pipe(
        Effect.withLogger(warningsIn(warnings)),
      );
      yield* reportSupervisorAvailability(true, available).pipe(
        Effect.withLogger(warningsIn(warnings)),
      );
      assert.deepStrictEqual(warnings, []);
    }),
  );
});

for (const settings of [
  { supervisor_limits: { conversation_size_mib: 73 } },
  { supervisor_limits: { conversation_size_mib: 73 }, supervisor_image_pull_timeout_minutes: 2 },
]) {
  const pullTimeout = settings.supervisor_image_pull_timeout_minutes;
  it.effect(
    `applies supervisor limits and image pull timeout ${pullTimeout ?? "unset"} from settings`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const temporary = yield* fs.makeTempDirectoryScoped();
        const directory = InstanceDirectory.make(temporary);
        const config = yield* Schema.decodeEffect(UsineConfig)({
          version: 1,
          repos: [],
          settings,
          workers: [
            {
              name: "remote",
              kind: "ssh",
              destination: "worker",
              root: "/srv/usine",
              max_concurrent_attempts: 1,
              gateway: {
                domain: "gw.internal",
                destination: "gateway",
                admin_token_env: "TEST_GATEWAY_TOKEN",
              },
            },
          ],
        });
        const loaded = LoadedInstance.make({
          config,
          agents: [],
          invalidAgents: [],
          loops: [],
          quarantinedLoops: [],
          warnings: [],
        });
        const calls: Array<ReadonlyArray<string>> = [];
        const commands = spawning((command, args) => {
          if (command === "podman") {
            if (args[0] === "image") return { stdout: "", exitCode: 1 };
            if (args[0] === "pull")
              return {
                stdout: "",
                exitCode: 0,
                duration:
                  calls.filter(([, verb]) => verb === "pull").length === 1 ? "11 minutes" : 0,
              };
            return { stdout: args[0] === "info" ? "true" : "", exitCode: 0 };
          }
          if (command === "fallocate" && args[0] === "-l")
            return { stdout: "", stderr: "allocation stopped by test", exitCode: 1 };
          return { stdout: "", exitCode: command === "mountpoint" && args[0] === "-q" ? 32 : 0 };
        }, calls);
        const context = yield* Layer.build(
          supervisorSandboxLayer(
            directory,
            InstanceId.make("00000000-0000-4000-8000-000000000001"),
          ).pipe(
            Layer.provide(commands),
            Layer.provide(
              Layer.succeed(CurrentInstance)({
                get: Effect.succeed(loaded),
                changes: Stream.empty,
                reload: Effect.die("no reload"),
                commit: () => Effect.die("no commit"),
                registerWorkers: () => Effect.void,
                registerParentAdmission: () => Effect.void,
              }),
            ),
          ),
        );
        const sandbox = Context.get(context, SupervisorSandbox);
        yield* TestClock.withLive(
          Effect.sleep("10 millis").pipe(
            Effect.repeat({ until: () => calls.some(([, command]) => command === "pull") }),
          ),
        );
        yield* TestClock.adjust(pullTimeout === undefined ? "11 minutes" : "3 minutes");
        assert.lengthOf(
          calls.filter(([, command]) => command === "pull"),
          pullTimeout === undefined ? 1 : 2,
        );
        const error = yield* sandbox
          .open(
            SandboxRequest.make({
              conversation: AgentSessionId.make("test"),
              harness: Harness.make("codex"),
              model: ModelId.make("m"),
              sources: [],
            }),
          )
          .pipe(Effect.scoped, Effect.flip);
        assert.include(error.message, "allocation stopped by test");
        const allocation = calls.find(
          ([command, flag]) => command === "fallocate" && flag === "-l",
        );
        assert.strictEqual(allocation?.[2], String(73 * 1024 ** 2));
      }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );
}
