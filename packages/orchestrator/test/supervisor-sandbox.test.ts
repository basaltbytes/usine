import { NodeFileSystem } from "@effect/platform-node";
import { UsineConfig } from "@usine/config/factory";
import { LoadedInstance } from "@usine/config/instance";
import { InstanceDirectory, InstanceId } from "@usine/core/instance";
import { SupervisorSandbox } from "@usine/agents/supervisor";
import { Context, FileSystem, Layer, Schema, Stream } from "effect";
import { spawning } from "../../executor/test/supervisor/runtime-fixture.ts";
import { CurrentInstance } from "../src/current-instance/current-instance.ts";
import { supervisorSandboxLayer } from "../src/supervisor-sandbox.ts";
import { TestClock } from "effect/testing";
import { assert, describe, it } from "@effect/vitest";
import { type SupervisorSandboxService, SupervisorUnavailable } from "@usine/agents/supervisor";
import { Effect, Logger, Option } from "effect";
import { reportSupervisorAvailability } from "../src/supervisor-sandbox.ts";

const warningsIn = (warnings: Array<unknown>) =>
  Logger.make<unknown, void>(({ logLevel, message }) => {
    if (logLevel === "Warn") warnings.push(message);
  });

const missing = SupervisorUnavailable.make({
  message:
    "Supervisor sessions run in a container, and Podman or Docker isn't installed on the orchestrator host",
});

const unavailable: SupervisorSandboxService = {
  unavailable: Effect.succeedSome(missing),
  checked: Effect.succeedSome(missing),
  open: () => Effect.die("the test opens no sandbox"),
  save: () => Effect.die("the test opens no sandbox"),
};

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
          return undefined;
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
        yield* TestClock.adjust("119 seconds");
        assert.lengthOf(
          calls.filter(([, command]) => command === "pull"),
          1,
        );
        yield* TestClock.adjust(pullTimeout === undefined ? "541 seconds" : "61 seconds");
        assert.lengthOf(
          calls.filter(([, command]) => command === "pull"),
          pullTimeout === undefined ? 1 : 2,
        );
        const checked = yield* sandbox.checked;
        assert.deepStrictEqual(checked, Option.none());
        const check = calls.find(([, command]) => command === "run") ?? [];
        assert.isTrue(check.some((arg) => arg.includes(`tmpfs-size=${73 * 1024 ** 2}`)));
      }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );
}
