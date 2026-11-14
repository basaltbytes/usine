import { NodeFileSystem } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { SandboxRequest, SupervisorSandbox } from "@usine/agents/supervisor";
import { Harness, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId } from "@usine/core/agent/session";
import { ContainerImage } from "@usine/core/worker";
import {
  Context,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { containerSandboxLayer } from "../../src/supervisor/container.ts";
import { podman, type RuntimeState } from "./runtime-fixture.ts";

const image = ContainerImage.make("docker.io/library/node:22-slim");
const pullCommand = ["podman", "pull", image];
const sandboxAt = (root: string, imagePullTimeout?: Duration.Duration) =>
  containerSandboxLayer({
    root,
    imagePullTimeout,
    image,
    runtime: Option.none(),
    route: Option.some(
      Effect.succeed({
        credential: () => Effect.succeedNone,
        request: () => Effect.die("the test calls no model"),
      }),
    ),
  }).pipe(
    Layer.build,
    Effect.map((context) => Context.get(context, SupervisorSandbox)),
  );

const codexTurn = (conversation: string) =>
  SandboxRequest.make({
    model: ModelId.make("m"),
    conversation: AgentSessionId.make(conversation),
    harness: Harness.make("codex"),
    sources: [],
  });

describe("supervisor image preparation", () => {
  it.effect("releases a stalled image inspection after 15 seconds and retries a minute later", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const calls: Array<ReadonlyArray<string>> = [];
      const releases: Array<ReadonlyArray<string>> = [];
      const warnings: Array<unknown> = [];
      const runtime: RuntimeState = { starts: true, image: "hang" };
      const inspect = ["podman", "image", "inspect", image];
      yield* Effect.gen(function* () {
        const sandbox = yield* sandboxAt(root);
        yield* TestClock.withLive(
          Effect.sleep("10 millis").pipe(
            Effect.repeat({ until: () => calls.some(([, command]) => command === "image") }),
          ),
        );
        yield* TestClock.adjust("14 seconds");
        assert.notDeepInclude(releases, inspect);
        assert.isEmpty(warnings);
        yield* TestClock.adjust("1 second");
        assert.deepInclude(releases, inspect);
        assert.deepStrictEqual(warnings, [
          [
            "Supervisor image preparation failed; retrying in one minute",
            {
              image,
              message: "Cannot prepare the supervisor image: Operation timed out after '15s'",
            },
          ],
        ]);
        runtime.image = { stdout: "cached", exitCode: 0 };
        yield* TestClock.adjust("59 seconds");
        assert.lengthOf(
          calls.filter(([, command]) => command === "image"),
          1,
        );
        yield* TestClock.adjust("1 second");
        yield* sandbox.open(codexTurn("inspection-recovered")).pipe(Effect.scoped);
        assert.lengthOf(
          calls.filter(([, command]) => command === "image"),
          2,
        );
      }).pipe(
        Effect.scoped,
        Effect.provide([
          podman(calls, [], runtime, true, releases),
          Logger.layer([
            Logger.make<unknown, void>(({ logLevel, message }) => {
              if (logLevel === "Warn") warnings.push(message);
            }),
          ]),
        ]),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("releases an active pull when the sandbox shuts down", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const calls: Array<ReadonlyArray<string>> = [];
      const releases: Array<ReadonlyArray<string>> = [];
      yield* Effect.gen(function* () {
        yield* sandboxAt(root);
        yield* TestClock.withLive(
          Effect.sleep("10 millis").pipe(
            Effect.repeat({ until: () => calls.some(([, command]) => command === "pull") }),
          ),
        );
        assert.notDeepInclude(releases, pullCommand);
      }).pipe(
        Effect.scoped,
        Effect.provide(podman(calls, [], { starts: true, pull: "hang" }, true, releases)),
      );
      assert.deepInclude(releases, pullCommand);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  for (const progress of ["Trying to pull image...\n", "Copying layer...\n".repeat(1000)]) {
    it.effect(
      `drains pull output and logs the failure after ${progress.length} characters of progress`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped();
          const warnings: Array<unknown> = [];
          const encoder = new TextEncoder();
          const denial = "Error: registry access denied\n";
          const chunks = Array.from({ length: 32 }, () => encoder.encode("progress".repeat(2000)));
          let drainedBytes = 0;
          const stdout = Stream.fromIterable(chunks).pipe(
            Stream.tap((chunk) =>
              Effect.sync(() => {
                drainedBytes += chunk.length;
              }),
            ),
          );
          yield* Effect.gen(function* () {
            yield* sandboxAt(root);
            yield* TestClock.withLive(
              Effect.sleep("10 millis").pipe(Effect.repeat({ until: () => warnings.length > 0 })),
            );
            assert.strictEqual(drainedBytes, 32 * 2000 * "progress".length);
            assert.deepStrictEqual(warnings, [
              [
                "Supervisor image preparation failed; retrying in one minute",
                {
                  image,
                  message: `Cannot pull the supervisor image: ${(progress + denial).slice(-8192).trim()}`,
                },
              ],
            ]);
          }).pipe(
            Effect.scoped,
            Effect.provide([
              podman([], [], {
                starts: true,
                pull: {
                  stdout,
                  stderr: Stream.make(encoder.encode(progress), encoder.encode(denial)),
                  exitCode: 125,
                },
              }),
              Logger.layer([
                Logger.make<unknown, void>(({ logLevel, message }) => {
                  if (logLevel === "Warn") warnings.push(message);
                }),
              ]),
            ]),
          );
        }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
    );
  }

  it.live("opens with a cached image during a registry outage without pulling", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const calls: Array<ReadonlyArray<string>> = [];
      yield* Effect.gen(function* () {
        const sandbox = yield* sandboxAt(root);
        yield* sandbox.open(codexTurn("cached")).pipe(Effect.scoped);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          podman(calls, [], {
            starts: true,
            image: { stdout: "cached", exitCode: 0 },
            pull: { stdout: "", stderr: "registry unavailable", exitCode: 1 },
          }),
        ),
      );
      assert.isFalse(calls.some(([, command]) => command === "pull"));
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("starts during a stalled pull and recovers after the configured timeout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const calls: Array<ReadonlyArray<string>> = [];
      const releases: Array<ReadonlyArray<string>> = [];
      const runtime: RuntimeState = { starts: true, pull: "hang" };
      yield* Effect.gen(function* () {
        const sandbox = yield* sandboxAt(root, Duration.minutes(5));
        assert(Option.isNone(sandbox.unavailable));
        yield* TestClock.withLive(
          Effect.sleep("10 millis").pipe(
            Effect.repeat({ until: () => calls.some(([, command]) => command === "pull") }),
          ),
        );
        const waiting = yield* sandbox
          .open(codexTurn("waiting"))
          .pipe(Effect.scoped, Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("30 seconds");
        const refused = yield* Fiber.join(waiting);
        assert.include(refused.message, "still being prepared");
        assert.notDeepInclude(releases, pullCommand);
        yield* TestClock.adjust("270 seconds");
        assert.deepInclude(releases, pullCommand);
        runtime.pull = { stdout: "", exitCode: 0 };
        yield* TestClock.adjust("1 minute");
        yield* sandbox.open(codexTurn("recovered")).pipe(Effect.scoped);
        assert.lengthOf(
          calls.filter(([, command]) => command === "pull"),
          2,
        );
      }).pipe(Effect.scoped, Effect.provide(podman(calls, [], runtime, true, releases)));
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("finishes a slow image pull beyond both former command timeouts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const calls: Array<ReadonlyArray<string>> = [];
      yield* Effect.gen(function* () {
        const sandbox = yield* sandboxAt(root);
        yield* TestClock.withLive(
          Effect.sleep("10 millis").pipe(
            Effect.repeat({ until: () => calls.some(([, command]) => command === "pull") }),
          ),
        );
        yield* TestClock.adjust("11 minutes");
        assert.lengthOf(
          calls.filter(([, command]) => command === "pull"),
          1,
        );
        yield* sandbox.open(codexTurn("slow-pull")).pipe(Effect.scoped);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          podman(calls, [], {
            starts: true,
            pull: { stdout: "progress".repeat(20000), exitCode: 0, duration: "11 minutes" },
          }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );
});
