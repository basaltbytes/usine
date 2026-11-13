import { NodeFileSystem } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { SupervisorSandbox, SandboxRequest } from "@usine/agents/supervisor";
import { Harness, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId } from "@usine/core/agent/session";
import { ContainerImage, SupervisorLimits } from "@usine/core/worker";
import { Effect, FileSystem, Layer, Option } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { containerSandboxLayer } from "../../src/supervisor/container.ts";
import { mountConversation } from "../../src/supervisor/storage.ts";
import { podman, spawning } from "./runtime-fixture.ts";

const turn = SandboxRequest.make({
  conversation: AgentSessionId.make("bounded"),
  harness: Harness.make("codex"),
  model: ModelId.make("m"),
  sources: [],
});

describe("bounded supervisor storage", () => {
  it.live("refuses turns when filesystem tools are missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const calls: Array<ReadonlyArray<string>> = [];
      const sandbox = yield* SupervisorSandbox.pipe(
        Effect.provide(
          containerSandboxLayer({
            root,
            image: ContainerImage.make("node:22-slim"),
            runtime: Option.some("docker"),
            route: Option.some(
              Effect.succeed({
                credential: () => Effect.succeedNone,
                request: () => Effect.die("no request reaches an unavailable sandbox"),
              }),
            ),
          }).pipe(
            Layer.provide(
              spawning((command, args) => {
                if (command !== "docker") return undefined;
                return { stdout: args[0] === "info" ? "[]" : "", exitCode: 0 };
              }, calls),
            ),
          ),
        ),
      );
      assert(Option.isSome(sandbox.unavailable));
      const failure = yield* sandbox.open(turn).pipe(Effect.flip);
      assert.include(failure.message, "fuse2fs");
      assert.isFalse(calls.some(([, command]) => command === "run"));
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.live("removes a partial image when preallocation fails, without mounting", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const calls: Array<ReadonlyArray<string>> = [];
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner.pipe(
        Effect.provide(
          spawning(
            (command) => ({
              stdout: "",
              stderr: "no space",
              exitCode: command === "mountpoint" ? 32 : 1,
            }),
            calls,
          ),
        ),
      );
      const failure = yield* mountConversation(
        fs,
        spawner,
        root,
        "test",
        SupervisorLimits.make({}),
      ).pipe(Effect.scoped, Effect.flip);
      assert.include(failure.message, "fallocate failed");
      const files = yield* fs.readDirectory(`${root}/disks`);
      assert.deepStrictEqual(files, []);
      assert.isFalse(calls.some(([command]) => command === "fuse2fs"));
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.live("unmounts the conversation when its turn scope ends", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const calls: Array<ReadonlyArray<string>> = [];
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner.pipe(
        Effect.provide(podman(calls)),
      );
      yield* mountConversation(fs, spawner, root, "test", SupervisorLimits.make({})).pipe(
        Effect.scoped,
      );
      assert.deepStrictEqual(
        calls.filter(([command, flag]) => command === "fusermount" && flag === "-u"),
        [["fusermount", "-u", `${root}/conversations/test`]],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.live("refuses an existing image with the wrong size instead of growing it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${root}/disks`);
      yield* fs.writeFileString(`${root}/disks/test.ext4`, "old image");
      const calls: Array<ReadonlyArray<string>> = [];
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner.pipe(
        Effect.provide(podman(calls)),
      );
      const failure = yield* mountConversation(
        fs,
        spawner,
        root,
        "test",
        SupervisorLimits.make({}),
      ).pipe(Effect.scoped, Effect.flip);
      assert.include(failure.message, "migrate it");
      const contents = yield* fs.readFileString(`${root}/disks/test.ext4`);
      assert.strictEqual(contents, "old image");
      assert.isFalse(calls.some(([command]) => command === "fallocate" || command === "fuse2fs"));
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );
});
