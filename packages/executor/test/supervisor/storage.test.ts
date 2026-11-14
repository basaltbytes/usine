import { NodeFileSystem, NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { SupervisorSandbox, SandboxRequest } from "@usine/agents/supervisor";
import { Harness, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId } from "@usine/core/agent/session";
import { ContainerImage, SupervisorLimits } from "@usine/core/worker";
import { Context, Effect, Fiber, FileSystem, Layer, Logger, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
import { containerSandboxLayer } from "../../src/supervisor/container.ts";
import { mountConversation } from "../../src/supervisor/storage.ts";
import { directoryName } from "../../src/supervisor/names.ts";
import { podman, spawning, type RuntimeState } from "./runtime-fixture.ts";

const turn = SandboxRequest.make({
  conversation: AgentSessionId.make("bounded"),
  harness: Harness.make("codex"),
  model: ModelId.make("m"),
  sources: [],
});

const sandboxAt = (root: string) =>
  containerSandboxLayer({
    root,
    image: ContainerImage.make("node:22-slim"),
    runtime: Option.some("podman"),
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

describe("bounded supervisor storage", () => {
  for (const stalled of ["mount", "allocation"] as const) {
    it.effect(
      `refuses a stalled ${stalled} within its deadline and releases the conversation`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped();
          const calls: Array<ReadonlyArray<string>> = [];
          const releases: Array<ReadonlyArray<string>> = [];
          const runtime: RuntimeState = { starts: true, [stalled]: "hang" };
          yield* Effect.gen(function* () {
            const sandbox = yield* sandboxAt(root);
            const opening = yield* sandbox
              .open(turn)
              .pipe(Effect.scoped, Effect.flip, Effect.forkChild);
            const command = stalled === "mount" ? "fuse2fs" : "fallocate";
            const flag = stalled === "mount" ? "-f" : "-l";
            yield* TestClock.withLive(
              Effect.sleep("10 millis").pipe(
                Effect.repeat({ until: () => calls.some(([c, f]) => c === command && f === flag) }),
              ),
            );
            yield* TestClock.adjust(stalled === "mount" ? "9 seconds" : "29 seconds");
            assert.isUndefined(opening.pollUnsafe());
            yield* TestClock.adjust("1 second");
            const failure = yield* Fiber.join(opening);
            assert.include(failure.message, "Cannot mount the supervisor conversation filesystem");
            assert.include(failure.message, stalled === "mount" ? "10s" : "30s");
            assert.isTrue(releases.some(([c, f]) => c === command && f === flag));
            assert.isFalse(calls.some(([c, f]) => c === "podman" && f === "run"));
            delete runtime[stalled];
            yield* sandbox.open(turn).pipe(Effect.scoped);
          }).pipe(Effect.scoped, Effect.provide(podman(calls, [], runtime, true, releases)));
        }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
    );
  }

  for (const keepsOutputOpen of [false, true]) {
    it.effect(
      `logs the mount error after process exit, with output left open: ${keepsOutputOpen}`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped();
          const calls: Array<ReadonlyArray<string>> = [];
          const warnings: Array<unknown> = [];
          const detail =
            "fusermount: option allow_other only allowed if 'user_allow_other' is set in /etc/fuse.conf";
          const output = Stream.fromEffect(
            Effect.succeed(new TextEncoder().encode(`${detail}\n`)).pipe(
              Effect.delay("100 millis"),
            ),
          );
          const runtime: RuntimeState = {
            starts: true,
            mount: {
              stdout: "",
              stderr: keepsOutputOpen ? Stream.concat(output, Stream.never) : output,
              exitCode: 1,
            },
          };
          yield* Effect.gen(function* () {
            const sandbox = yield* sandboxAt(root);
            const opening = yield* sandbox
              .open(turn)
              .pipe(Effect.scoped, Effect.flip, Effect.forkChild);
            yield* TestClock.withLive(
              Effect.sleep("10 millis").pipe(
                Effect.repeat({
                  until: () => calls.some(([c, f]) => c === "fuse2fs" && f === "-f"),
                }),
              ),
            );
            yield* TestClock.adjust("100 millis");
            if (keepsOutputOpen) yield* TestClock.adjust("900 millis");
            const failure = yield* Fiber.join(opening);
            assert.strictEqual(
              failure.message,
              `Cannot mount the supervisor conversation filesystem: fuse2fs exited with 1: ${detail}`,
            );
            assert.deepInclude(warnings, [
              "Supervisor conversation mount refused",
              {
                directory: `${root}/conversations/${directoryName(turn.conversation)}`,
                message: failure.message,
              },
            ]);
            assert.isFalse(calls.some(([c, f]) => c === "podman" && f === "run"));
            delete runtime.mount;
            yield* sandbox.open(turn).pipe(Effect.scoped);
          }).pipe(
            Effect.scoped,
            Effect.provide([
              podman(calls, [], runtime),
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

  it.live("keeps only the last 8,192 diagnostic characters when a mount fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const calls: Array<ReadonlyArray<string>> = [];
      const detail = "DENIED: user_allow_other";
      const encoder = new TextEncoder();
      const failure = yield* Effect.gen(function* () {
        const sandbox = yield* sandboxAt(root);
        return yield* sandbox.open(turn).pipe(Effect.scoped, Effect.flip);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          podman(calls, [], {
            starts: true,
            mount: {
              stdout: "",
              stderr: Stream.make(
                encoder.encode("a".repeat(12_000)),
                encoder.encode("b".repeat(8_192)),
                encoder.encode(detail),
              ),
              exitCode: 1,
            },
          }),
        ),
      );
      const prefix = "Cannot mount the supervisor conversation filesystem: fuse2fs exited with 1: ";
      assert.lengthOf(failure.message, prefix.length + 8_192);
      assert.strictEqual(failure.message, prefix + "b".repeat(8_192 - detail.length) + detail);
      assert.isFalse(calls.some(([c, f]) => c === "podman" && f === "run"));
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.live("refuses an unrepaired filesystem before mounting or starting a container", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const calls: Array<ReadonlyArray<string>> = [];
      const detail = "Filesystem errors left uncorrected; run fsck manually";
      const failure = yield* Effect.gen(function* () {
        const sandbox = yield* sandboxAt(root);
        return yield* sandbox.open(turn).pipe(Effect.scoped, Effect.flip);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          podman(calls, [], {
            starts: true,
            filesystemCheck: { stdout: "", stderr: detail, exitCode: 4 },
          }),
        ),
      );
      assert.strictEqual(
        failure.message,
        `Cannot mount the supervisor conversation filesystem: e2fsck failed: ${detail}`,
      );
      assert.isTrue(calls.some(([c, f]) => c === "e2fsck" && f === "-p"));
      assert.isFalse(calls.some(([c, f]) => c === "fuse2fs" && f === "-f"));
      assert.isFalse(calls.some(([c, f]) => c === "podman" && f === "run"));
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.live("keeps stderr from a real mount process that writes and immediately exits", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const runtimeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner.pipe(
        Effect.provide(podman([])),
      );
      const detail =
        "fusermount: option allow_other only allowed if 'user_allow_other' is set in /etc/fuse.conf";
      const spawner = ChildProcessSpawner.make((command) =>
        command._tag === "StandardCommand" &&
        command.command === "fuse2fs" &&
        command.args[0] === "-f"
          ? realSpawner.spawn(
              ChildProcess.make("/bin/sh", ["-c", 'printf "%s" "$0" >&2; exit 1', detail]),
            )
          : runtimeSpawner.spawn(command),
      );
      const failure = yield* Effect.gen(function* () {
        const sandbox = yield* sandboxAt(root);
        return yield* sandbox.open(turn).pipe(Effect.scoped, Effect.flip);
      }).pipe(
        Effect.scoped,
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      assert.include(failure.message, `fuse2fs exited with 1: ${detail}`);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("finishes startup after 15 seconds when checking a leftover mount stalls", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${root}/conversations/${directoryName(turn.conversation)}`, {
        recursive: true,
      });
      const calls: Array<ReadonlyArray<string>> = [];
      const releases: Array<ReadonlyArray<string>> = [];
      yield* Effect.gen(function* () {
        const starting = yield* sandboxAt(root).pipe(Effect.forkChild);
        yield* TestClock.withLive(
          Effect.sleep("10 millis").pipe(
            Effect.repeat({
              until: () => calls.some(([c, f]) => c === "mountpoint" && f === "-q"),
            }),
          ),
        );
        yield* TestClock.adjust("14 seconds");
        assert.isUndefined(starting.pollUnsafe());
        yield* TestClock.adjust("1 second");
        const sandbox = yield* Fiber.join(starting);
        assert(Option.isSome(sandbox.unavailable));
        const failure = yield* sandbox.open(turn).pipe(Effect.scoped, Effect.flip);
        assert.include(failure.message, "15s");
        assert.isTrue(releases.some(([c, f]) => c === "mountpoint" && f === "-q"));
        assert.isFalse(calls.some(([c, f]) => c === "podman" && f === "run"));
      }).pipe(
        Effect.scoped,
        Effect.provide(podman(calls, [], { starts: true, mountCheck: "hang" }, true, releases)),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

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

  it.live("logs a leftover mount reset and a repaired conversation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const logs: Array<unknown> = [];
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner.pipe(
        Effect.provide(podman([], [], { starts: true, staleMount: true, repaired: true })),
      );
      yield* mountConversation(fs, spawner, root, "test", SupervisorLimits.make({})).pipe(
        Effect.scoped,
        Effect.withLogger(
          Logger.make(({ logLevel, message }) => {
            logs.push({ logLevel, message });
          }),
        ),
      );
      const directory = `${root}/conversations/test`;
      assert.deepInclude(logs, {
        logLevel: "Info",
        message: ["Unmounting a previous supervisor filesystem before a turn", { directory }],
      });
      assert.deepInclude(logs, {
        logLevel: "Warn",
        message: ["Repaired a supervisor conversation filesystem", { directory }],
      });
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
