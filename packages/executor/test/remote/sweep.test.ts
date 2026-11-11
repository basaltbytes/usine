import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { ExecShell } from "@usine/agents/child-host";
import { AttemptId } from "@usine/core/attempt";
import { jsonKey } from "@usine/core/json-key";
import { WorkerName } from "@usine/core/worker";
import { Effect, Logger, References, Stream } from "effect";
import { remoteCommandsFor } from "../../src/remote/commands.ts";
import { abandonedWorktreeSweepFor } from "../../src/remote/sweep.ts";

const encoder = new TextEncoder();
const WORKER_DIRECTORY = "/home/usine/.usine/workers/hetzner";
const ATTEMPTS = `${WORKER_DIRECTORY}/attempts`;

/** Returns a machine whose `attempts` directory lists `paths` and whose `repos` is empty. */
const machineListing = (paths: ReadonlyArray<string>) =>
  ExecShell.make({
    destination: "hetzner-1",
    transport: {
      run: (line) =>
        Effect.succeed({
          stdout:
            line.includes("'find'") && line.includes("/attempts'")
              ? Stream.make(encoder.encode(paths.map((path) => `${path}\0`).join("")))
              : Stream.empty,
          stderr: Stream.empty,
          exitCode: Effect.succeed(0),
        }),
    },
  });

it.effect(
  "warns once about abandoned paths, not about the worktrees of Attempts being reattached",
  () =>
    Effect.gen(function* () {
      const triggering = AttemptId.make("932b2964a857cc2d9183a0905b134d51/review/1");
      const reattached = AttemptId.make("5d41402abc4b2a76b9719d911017c592/implement/2");
      const abandoned = `${ATTEMPTS}/crashed-before-a-record`;
      const shell = machineListing([
        `${ATTEMPTS}/932b2964a857cc2d9183a0905b134d51_review_1`,
        abandoned,
        `${ATTEMPTS}/5d41402abc4b2a76b9719d911017c592_implement_2`,
      ]);
      const logs: Array<readonly [string, string]> = [];
      const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
        logs.push([logLevel, jsonKey(message)]);
      });

      const commands = yield* remoteCommandsFor;
      const abandonedWorktrees = yield* abandonedWorktreeSweepFor(commands);
      yield* abandonedWorktrees.reattaching(reattached);
      yield* abandonedWorktrees
        .sweep(triggering, WorkerName.make("hetzner"), shell, WORKER_DIRECTORY)
        .pipe(
          Effect.provide(Logger.layer([logger])),
          Effect.provideService(References.MinimumLogLevel, "Debug"),
        );

      const warnings = logs.filter(([level]) => level === "Warn").map(([, line]) => line);
      assert.lengthOf(warnings, 1);
      assert.include(warnings[0], "Preserving abandoned remote paths for salvage reconciliation");
      assert.include(warnings[0], '"paths":1');
      assert.notInclude(warnings[0], "crashed-before-a-record");
      const preserved = logs.find(([level, line]) => level === "Debug" && line.includes(abandoned));
      assert.isDefined(preserved);
      assert.notInclude(preserved?.[1] ?? "", "_review_1");
      const completed = logs.find(([, line]) => line.includes("sweep completed"));
      assert.include(completed?.[1] ?? "", '"reattached":2,"abandoned":1');
    }).pipe(Effect.provide(NodeServices.layer)),
);
